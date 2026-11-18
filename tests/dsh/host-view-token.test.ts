import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../../src/dsh/host.js';

interface CapturedRoute {
  kind: string;
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
}

interface Harness {
  routes: CapturedRoute[];
  indexListeners: Array<(table: unknown[]) => void>;
  webServer: {
    register: (route: CapturedRoute) => () => void;
    collectIndexInjections: () => unknown[];
    tapIndex: () => void;
  };
}

function createHarness(connection?: { requestRejection: (request: { headers: Record<string, unknown> }) => 401 | 403 | undefined }): Harness {
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
      if (name === 'connection') return connection;
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
  return { routes, indexListeners, webServer };
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

test('the view token is delivered through the structured index injection table', () => {
  const { indexListeners } = createHarness();
  assert.equal(indexListeners.length, 1);
  const table: unknown[] = [];
  indexListeners[0]!(table);
  const row = table.find((entry): entry is { kind: string; name: string; value: string } =>
    entry !== null && typeof entry === 'object'
      && (entry as { kind?: unknown }).kind === 'global'
      && (entry as { name?: unknown }).name === '__DELIVERY_LOOP_TOKEN__');
  assert.ok(row, 'a global __DELIVERY_LOOP_TOKEN__ row is injected');
  assert.match(row.value, /^[0-9a-f]{48}$/);
});

test('the view API rejects a request without the injected token and accepts it with the token', async () => {
  const { routes, indexListeners } = createHarness();
  const table: unknown[] = [];
  indexListeners[0]!(table);
  const token = (table as Array<{ name: string; value: string }>)
    .find((entry) => entry.name === '__DELIVERY_LOOP_TOKEN__')!.value;
  const route = routes.find((candidate) => candidate.path === '/delivery-loop');
  assert.ok(route);

  const unauthorized = response();
  await route.handler({ headers: {}, method: 'GET', url: '/delivery-loop/health' }, unauthorized);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.body, /unauthorized/);

  const authorized = response();
  await route.handler({
    headers: { 'x-delivery-loop-token': token },
    method: 'GET',
    url: '/delivery-loop/health',
  }, authorized);
  assert.equal(authorized.status, 200);
  const payload = JSON.parse(authorized.body) as { ok: boolean; plugin: string; prefix: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.plugin, 'delivery-loop');
  assert.equal(payload.prefix, '/delivery-loop');
});

test('a DSH browser session admitted by ctx.connection authenticates the view API without a process token', async () => {
  const { routes } = createHarness({
    requestRejection: (request) => (request.headers['cookie'] === 'session=ok' ? undefined : 401),
  });
  const route = routes.find((candidate) => candidate.path === '/delivery-loop');
  assert.ok(route);

  const admitted = response();
  await route.handler({
    headers: { cookie: 'session=ok' },
    method: 'GET',
    url: '/delivery-loop/health',
  }, admitted);
  assert.equal(admitted.status, 200);

  const denied = response();
  await route.handler({ headers: {}, method: 'GET', url: '/delivery-loop/health' }, denied);
  assert.equal(denied.status, 401);
});
