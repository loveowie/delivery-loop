import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DshSubagentWorkerAdapter } from '../../src/workers/dsh-subagent-adapter.js';
import type { AgentRequest } from '../../src/domain/types.js';

const parent = { id: 'parent-agent' };

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    run_id: 'R-1',
    task_id: 'TASK-1',
    role: 'implementer',
    capability_profile: 'portable',
    required_skills: [],
    objective: 'Add a greeting',
    workdir: '/tmp/worktree',
    requirement_ids: ['REQ-1'],
    acceptance_ids: ['ACC-1'],
    scope_paths: ['src/'],
    constraints: [],
    verification_commands: ['npm test'],
    context_files: [],
    timeout_seconds: 30,
    ...overrides,
  };
}

function result(structured: unknown, stopReason = 'completed') {
  return Promise.resolve({
    output: [],
    structured,
    stopReason,
  });
}

const completed = {
  task_id: 'TASK-1',
  status: 'completed',
  summary: 'done',
  files_changed: ['src/a.ts'],
  commands_run: [],
  findings: [],
  remaining_risks: [],
  suggested_tasks: [],
  blockers: [],
};

test('DSH worker adapter starts a caller-delivered structured subagent', async () => {
  let captured: Record<string, unknown> | undefined;
  let childAgent: { id: string; ctx: { on: (event: string, listener: (session: { id: string }, event: { type: string; data?: unknown }) => void) => () => void } } | undefined;
  const host = {
    agents: {
      get(id: string) { return id === parent.id ? parent : childAgent?.id === id ? childAgent : undefined; },
      list() { return [parent]; },
    },
    subagents: {
      getProvider(name: string) { return name === 'spawn' ? {} : undefined; },
      async startActivation(spec: Record<string, unknown>) {
        captured = spec;
        childAgent = {
          id: String(spec.childId),
          ctx: {
            on(_event, listener) {
              listener({ id: String(spec.childId) }, { type: 'assistant/message', data: { usage: { totalTokens: 123 } } });
              return () => {};
            },
          },
        };
        return {
          childId: String(spec.childId),
          result: result(completed),
          dispose: async () => {},
        };
      },
    },
  };
  const adapter = new DshSubagentWorkerAdapter({
    host: host as never,
    schemaPath: join(process.cwd(), 'schemas', 'agent-result.schema.json'),
    resolveParent: (runId) => runId === 'R-1' ? parent : undefined,
  });
  const value = await adapter.run(request(), {});
  assert.equal(value.status, 'completed');
  assert.equal(value.task_id, 'TASK-1');
  assert.deepEqual(value.files_changed, ['src/a.ts']);
  assert.equal(value.token_usage, 123);
  assert.equal(captured?.delivery, 'caller');
  assert.equal(captured?.cwd, '/tmp/worktree');
  assert.equal(captured?.parent, parent);
  assert.equal((captured?.outputSchema as { type?: string }).type, 'object');
  assert.equal('name' in (captured ?? {}), false);
  assert.match(String((captured?.prompt as Array<{ text: string }>)[0]?.text), /structured_output/);
});

test('DSH worker adapter rejects a mismatched task id and supports failures', async () => {
  const host = {
    agents: {
      get(id: string) { return id === parent.id ? parent : undefined; },
      list() { return [parent]; },
    },
    subagents: {
      getProvider() { return {}; },
      async startActivation() {
        return { childId: 'child-2', result: result({ ...completed, task_id: 'OTHER' }), dispose: async () => {} };
      },
    },
  };
  const adapter = new DshSubagentWorkerAdapter({
    host: host as never,
    schemaPath: join(process.cwd(), 'schemas', 'agent-result.schema.json'),
    resolveParent: () => parent,
  });
  const value = await adapter.run(request(), {});
  assert.equal(value.status, 'failed');
  assert.match(value.summary, /task_id mismatch/);
});

test('DSH worker adapter fails cleanly when no parent or provider is available', async () => {
  const noParent = new DshSubagentWorkerAdapter({
    host: {
      agents: { get() { return undefined; }, list() { return []; } },
      subagents: { getProvider() { return {}; }, async startActivation() { throw new Error('unexpected'); } },
    } as never,
    schemaPath: join(process.cwd(), 'schemas', 'agent-result.schema.json'),
    resolveParent: () => undefined,
  });
  const value = await noParent.run(request(), {});
  assert.equal(value.status, 'failed');
  assert.match(value.summary, /no live DSH parent/);

  const noProvider = new DshSubagentWorkerAdapter({
    host: {
      agents: { get() { return parent; }, list() { return [parent]; } },
      subagents: { getProvider() { return undefined; }, async startActivation() { throw new Error('unexpected'); } },
    } as never,
    schemaPath: join(process.cwd(), 'schemas', 'agent-result.schema.json'),
    resolveParent: () => parent,
  });
  const value2 = await noProvider.run(request(), {});
  assert.equal(value2.status, 'failed');
  assert.match(value2.summary, /not registered/);
});

test('DSH worker adapter retries activation when the parent context is torn down', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const host = {
    agents: {
      get(id: string) { return id === parent.id ? parent : undefined; },
      list() { return [parent]; },
    },
    subagents: {
      getProvider() { return {}; },
      async startActivation(spec: Record<string, unknown>) {
        calls += 1;
        if (calls === 1) throw new Error('cannot create effect on inactive context');
        return { childId: String(spec.childId), result: result(completed), dispose: async () => {} };
      },
    },
  };
  const adapter = new DshSubagentWorkerAdapter({
    host: host as never,
    schemaPath: join(process.cwd(), 'schemas', 'agent-result.schema.json'),
    resolveParent: () => parent,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    warn: (message) => { warnings.push(message); },
  });
  const value = await adapter.run(request(), {});
  assert.equal(value.status, 'completed');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [100]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /context was disposed/);
  assert.match(warnings[0]!, /parent-agent/);
  assert.match(warnings[0]!, /source=resolveParent/);
});

test('DSH worker adapter gives up after the bounded activation attempts', async () => {
  let calls = 0;
  const adapter = new DshSubagentWorkerAdapter({
    host: {
      agents: {
        get(id: string) { return id === parent.id ? parent : undefined; },
        list() { return [parent]; },
      },
      subagents: {
        getProvider() { return {}; },
        async startActivation() {
          calls += 1;
          throw new Error('cannot create effect on inactive context');
        },
      },
    } as never,
    schemaPath: join(process.cwd(), 'schemas', 'agent-result.schema.json'),
    resolveParent: () => parent,
    activationAttempts: 3,
    sleep: async () => {},
    warn: () => {},
  });
  const value = await adapter.run(request(), {});
  assert.equal(value.status, 'failed');
  assert.equal(calls, 3);
  assert.match(value.summary, /cannot create effect on inactive context/);
  assert.match(value.summary, /3 attempt/);
});

test('DSH worker adapter does not retry a configuration failure', async () => {
  let calls = 0;
  const adapter = new DshSubagentWorkerAdapter({
    host: {
      agents: {
        get(id: string) { return id === parent.id ? parent : undefined; },
        list() { return [parent]; },
      },
      subagents: {
        getProvider() { return {}; },
        async startActivation() {
          calls += 1;
          throw new Error('prompt rejected: invalid schema');
        },
      },
    } as never,
    schemaPath: join(process.cwd(), 'schemas', 'agent-result.schema.json'),
    resolveParent: () => parent,
    sleep: async () => {},
    warn: () => {},
  });
  const value = await adapter.run(request(), {});
  assert.equal(value.status, 'failed');
  assert.equal(calls, 1);
  assert.match(value.summary, /invalid schema/);
});
