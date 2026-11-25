import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply } from '../../src/dsh/host.js';

interface CapturedRoute {
  kind: string;
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
}

interface Harness {
  routes: CapturedRoute[];
  indexListeners: Array<(table: unknown[]) => void>;
  deliverWebServer: () => void;
  webServer: {
    register: (route: CapturedRoute) => () => void;
    collectIndexInjections: () => unknown[];
    tapIndex: () => void;
  };
}

interface HarnessOptions {
  // Model the real Host: `webServer` is provided by a sibling plugin and is
  // absent while this plugin's `apply` runs.
  deferWebServer?: boolean;
  // Model a Host context that predates `ctx.inject`.
  withoutInject?: boolean;
}

function createHarness(
  connection?: { requestRejection: (request: { headers: Record<string, unknown> }) => 401 | 403 | undefined },
  options: HarnessOptions = {},
): Harness {
  const routes: CapturedRoute[] = [];
  const indexListeners: Array<(table: unknown[]) => void> = [];
  const pendingInjections: Array<(scope: unknown) => void> = [];
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
  const services = (name: string): unknown => {
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
  };
  const on = (event: string, listener: (table: unknown[]) => void): (() => void) => {
    assert.equal(event, 'webserver/index-inject');
    indexListeners.push(listener);
    return () => {};
  };
  const effect = (run: () => (() => void) | void): (() => void) | void => run();
  const scope = {
    get: (name: string) => (name === 'webServer' ? webServer : services(name)),
    on,
    effect,
  };
  const ctx: Record<string, unknown> = {
    get: (name: string) => {
      if (name === 'webServer') return options.deferWebServer === true ? undefined : webServer;
      return services(name);
    },
    on,
    effect,
    tools: { register: () => {} },
  };
  if (options.withoutInject !== true) {
    ctx.inject = (deps: string[], callback: (scope: unknown) => void) => {
      assert.deepEqual(deps, ['webServer']);
      if (options.deferWebServer === true) pendingInjections.push(callback);
      else callback(scope);
    };
  }
  apply(ctx as never, {});
  return {
    routes,
    indexListeners,
    webServer,
    deliverWebServer: () => {
      for (const callback of pendingInjections.splice(0)) callback(scope);
    },
  };
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
  const payload = JSON.parse(authorized.body) as { ok: boolean; plugin: string; prefix: string; version: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.plugin, 'delivery-loop');
  assert.equal(payload.prefix, '/delivery-loop');
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(payload.version, manifest.version, 'the health payload reports the packed version');
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

test('the view API is registered once webServer is provided, not dropped while it is still missing', () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    const harness = createHarness(undefined, { deferWebServer: true });
    assert.equal(harness.routes.length, 0, 'nothing is registered before the service exists');
    assert.equal(
      warnings.some((line) => line.includes('webServer is unavailable')),
      false,
      'the plugin does not give up while the dependency is still pending',
    );

    harness.deliverWebServer();
    assert.equal(harness.routes.length, 1);
    assert.equal(harness.routes[0]!.path, '/delivery-loop');
    assert.equal(harness.indexListeners.length, 1, 'the token injection is installed with the routes');
  } finally {
    console.warn = warn;
  }
});

test('a Host context without ctx.inject still registers the view API when webServer is already up', () => {
  const harness = createHarness(undefined, { withoutInject: true });
  assert.equal(harness.routes.length, 1);
  assert.equal(harness.routes[0]!.path, '/delivery-loop');
});
