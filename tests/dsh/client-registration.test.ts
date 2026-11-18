import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface Registration {
  name: string;
  options: Record<string, unknown>;
  component: unknown;
}

function fakeReact(): Record<string, unknown> {
  return {
    createElement: (...args: unknown[]) => ({ args }),
    Fragment: Symbol('Fragment'),
    useEffect: () => {},
    useMemo: (factory: () => unknown) => factory(),
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [typeof value === 'function' ? (value as () => unknown)() : value, () => {}],
    useReducer: (_reducer: unknown, initial: unknown) => [initial, () => {}],
  };
}

function loadClient(): { apply: (ctx: unknown) => void } {
  let factory: ((require: (id: string) => unknown) => { apply: (ctx: unknown) => void }) | undefined;
  const window: Record<string, unknown> = {
    __ModuleLoader__: {
      load(definition: { id: string; factory: typeof factory }): void {
        factory = definition.factory;
      },
    },
  };
  const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
  const evaluate = new Function('window', source) as (scope: Record<string, unknown>) => void;
  evaluate(window);
  assert.ok(factory, 'client.js registers a module factory');
  const client = factory((id: string) => {
    if (id === 'react') return fakeReact();
    throw new Error(`unexpected client require: ${id}`);
  });
  return { apply: client.apply };
}

test('the client registers a sidebar board panel and its main-column page instead of a settings section', () => {
  const { apply } = loadClient();
  const registrations: Registration[] = [];
  const ctx = {
    effect: (effect: () => unknown) => effect(),
    locale: {
      register: () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
    },
    slots: {
      inject: (_owner: string, callback: () => unknown) => {
        const result = callback();
        if (result !== null && typeof result === 'object'
          && typeof (result as { next?: unknown }).next === 'function') {
          for (const _ of result as Generator<unknown>) {
            // Iterating runs the generator body, which performs registrations.
          }
        }
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ name: String(options.name), options, component });
        return () => {};
      },
    },
  };
  apply(ctx as never);

  const panel = registrations.find((entry) => entry.name === 'sidebar.panellist');
  assert.ok(panel, 'a sidebar.panellist row is registered');
  assert.equal(panel.options.id, 'delivery-loop');
  assert.equal(panel.options.order, 20);
  assert.equal(panel.options.locale, 'delivery-loop');
  assert.equal(typeof panel.options.label, 'function');
  assert.equal((panel.options.label as () => string)(), 'nav');

  const main = registrations.find((entry) => entry.name === 'main');
  assert.ok(main, 'the matching main keyed slot is registered');
  assert.equal(main.options.key, 'delivery-loop');

  assert.equal(registrations.some((entry) => entry.name === 'settings.section'), false);
  assert.ok(registrations.some((entry) => entry.name === 'conversation.composer.dock'));
  assert.ok(registrations.some((entry) => entry.name === 'shell.overlay'));
  assert.equal(registrations.filter((entry) => entry.name === 'tool.call.toolview').length, 10);
});
