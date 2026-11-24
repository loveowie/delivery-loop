import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../../src/dsh/host.js';

interface CapturedRoute {
  kind: string;
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
}

interface Harness {
  routes: CapturedRoute[];
  indexListeners: Array<(table: unknown[]) => void>;
}

function createHarness(): Harness {
  const routes: CapturedRoute[] = [];
  const indexListeners: Array<(table: unknown[]) => void> = [];
  const webServer = {
    register: (route: CapturedRoute) => {
      routes.push(route);
      return () => {};
    },
    collectIndexInjections: () => [],
    tapIndex: () => {
      throw new Error('tapIndex must not be used when structured injections are available');
    },
  };
  const ctx = {
    get: (name: string) => {
      if (name === 'agents') return { get: () => undefined, list: () => [] };
      if (name === 'subagents') {
        return {
          getProvider: () => undefined,
          startActivation: async () => {
            throw new Error('unused');
          },
        };
      }
      if (name === 'webServer') return webServer;
      return undefined;
    },
    on: (event: string, listener: (table: unknown[]) => void) => {
      assert.equal(event, 'webserver/index-inject');
      indexListeners.push(listener);
      return () => {};
    },
    effect: (effect: () => (() => void) | void) => effect(),
    tools: { register: () => {} },
  };
  apply(ctx as never, {});
  return { routes, indexListeners };
}

function response() {
  const state = { status: 0, body: '' };
  return {
    get status() { return state.status; },
    get body() { return state.body; },
    writeHead(status: number) { state.status = status; },
    end(body?: string) { state.body = body ?? ''; },
  };
}

function makeRequest(token: string, method: string, url: string, body?: unknown) {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.method = method;
  req.url = url;
  req.headers = { 'x-delivery-loop-token': token };
  req.setEncoding = () => {};
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== undefined) req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}

async function call(
  route: CapturedRoute,
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const res = response();
  await route.handler(makeRequest(token, method, url, body), res);
  return {
    status: res.status,
    payload: res.body.length === 0 ? {} : JSON.parse(res.body) as Record<string, unknown>,
  };
}

async function setup(): Promise<{ route: CapturedRoute; repo: string; home: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-settings-api-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  await mkdir(repo, { recursive: true });
  const realRepo = await realpath(repo);
  process.env.DELIVERY_LOOP_HOME = home;
  const { routes, indexListeners } = createHarness();
  const table: unknown[] = [];
  indexListeners[0]!(table);
  const token = (table as Array<{ name: string; value: string }>)
    .find((entry) => entry.name === '__DELIVERY_LOOP_TOKEN__')!.value;
  const route = routes.find((candidate) => candidate.path === '/delivery-loop');
  assert.ok(route);
  return { route, repo: realRepo, home, token };
}

const settingsUrl = (repo?: string) => repo === undefined
  ? '/delivery-loop/settings'
  : `/delivery-loop/settings?repo_root=${encodeURIComponent(repo)}`;

test('the settings API reports defaults for a repository without settings files', async () => {
  const { route, repo, token } = await setup();
  const result = await call(route, token, 'GET', settingsUrl(repo));
  assert.equal(result.status, 200);
  const payload = result.payload as {
    repo_root: string;
    global: { exists: boolean };
    repo: { exists: boolean; path: string };
    defaults: { max_total_tokens: number };
    effective: { max_total_tokens: number; max_duration_hours: number; max_task_attempts: number };
  };
  assert.equal(payload.repo_root, repo);
  assert.equal(payload.global.exists, false);
  assert.equal(payload.repo.exists, false);
  assert.equal(payload.repo.path, join(repo, '.delivery', 'settings.yaml'));
  assert.equal(payload.effective.max_total_tokens, 2_000_000);
  assert.equal(payload.effective.max_duration_hours, 8);
  assert.equal(payload.effective.max_task_attempts, 3);
});

test('the settings API saves global and repository budgets and merges them', async () => {
  const { route, repo, home, token } = await setup();
  const savedGlobal = await call(route, token, 'POST', '/delivery-loop/settings', {
    scope: 'global',
    runtime: { max_total_tokens: 4_000_000 },
  });
  assert.equal(savedGlobal.status, 200);
  const globalFile = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')) as {
    runtime: { max_total_tokens: number };
  };
  assert.equal(globalFile.runtime.max_total_tokens, 4_000_000);

  const savedRepo = await call(route, token, 'POST', '/delivery-loop/settings', {
    scope: 'repo',
    repo_root: repo,
    runtime: { max_duration_hours: 12, no_progress_cycles: 5 },
  });
  assert.equal(savedRepo.status, 200);
  assert.match(
    await readFile(join(repo, '.delivery', 'settings.yaml'), 'utf8'),
    /max_duration_hours: 12/,
  );

  const view = await call(route, token, 'GET', settingsUrl(repo));
  const effective = (view.payload as { effective: Record<string, number> }).effective;
  assert.equal(effective.max_total_tokens, 4_000_000);
  assert.equal(effective.max_duration_hours, 12);
  assert.equal(effective.no_progress_cycles, 5);
  assert.equal(effective.max_task_attempts, 3);
});

test('the settings API rejects non-budget keys, invalid values, and a missing repo scope', async () => {
  const { route, repo, token } = await setup();

  const forbidden = await call(route, token, 'POST', '/delivery-loop/settings', {
    scope: 'global',
    runtime: { git: { mode: 'merge' } },
  });
  assert.equal(forbidden.status, 400);
  assert.match(String(forbidden.payload.error), /invalid runtime limits/);

  const negative = await call(route, token, 'POST', '/delivery-loop/settings', {
    scope: 'global',
    runtime: { max_total_tokens: -1 },
  });
  assert.equal(negative.status, 400);

  const missingRepo = await call(route, token, 'POST', '/delivery-loop/settings', {
    scope: 'repo',
    runtime: { max_total_tokens: 1_000_000 },
  });
  assert.equal(missingRepo.status, 400);
  assert.match(String(missingRepo.payload.error), /repo_root is required/);

  const unknownRepo = await call(route, token, 'POST', '/delivery-loop/settings', {
    scope: 'repo',
    repo_root: join(repo, 'does-not-exist'),
    runtime: { max_total_tokens: 1_000_000 },
  });
  assert.equal(unknownRepo.status, 400);
  assert.match(String(unknownRepo.payload.error), /repository not found/);
});

test('the settings API can reset a scope back to the defaults', async () => {
  const { route, repo, token } = await setup();
  await call(route, token, 'POST', '/delivery-loop/settings', {
    scope: 'repo',
    repo_root: repo,
    runtime: { max_duration_hours: 12 },
  });
  const reset = await call(route, token, 'POST', '/delivery-loop/settings', {
    scope: 'repo',
    repo_root: repo,
    reset: true,
  });
  assert.equal(reset.status, 200);
  await assert.rejects(stat(join(repo, '.delivery', 'settings.yaml')));
  const view = await call(route, token, 'GET', settingsUrl(repo));
  assert.equal((view.payload as { effective: Record<string, number> }).effective.max_duration_hours, 8);
});
