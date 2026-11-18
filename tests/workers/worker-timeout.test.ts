import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DshSubagentWorkerAdapter } from '../../src/workers/dsh-subagent-adapter.js';
import type { DshSubagentServices } from '../../src/workers/dsh-subagent-adapter.js';
import type { AgentRequest } from '../../src/domain/types.js';

const parent = { id: 'parent-agent' };
const schemaPath = join(process.cwd(), 'schemas', 'agent-result.schema.json');

const completedStructured = {
  task_id: 'TASK-1',
  status: 'completed',
  summary: 'done',
  files_changed: [],
  commands_run: [],
  findings: [],
  remaining_risks: [],
  suggested_tasks: [],
  blockers: [],
};

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
    timeout_seconds: 1,
    ...overrides,
  };
}

function adapterWith(
  startActivation: DshSubagentServices['subagents']['startActivation'],
): DshSubagentWorkerAdapter {
  const host: DshSubagentServices = {
    agents: {
      get: (id) => (id === parent.id ? parent : undefined),
      list: () => [parent],
    },
    subagents: {
      getProvider: () => ({}),
      startActivation,
    },
  };
  return new DshSubagentWorkerAdapter({ host, schemaPath, resolveParent: () => parent });
}

test('a worker that ignores the abort is failed and disposed at the timeout', { timeout: 15_000 }, async () => {
  let disposed = 0;
  const adapter = adapterWith(async (spec) => ({
    childId: String(spec.childId),
    // A provider that never settles and ignores the forwarded abort signal.
    result: new Promise(() => {}),
    dispose: async () => {
      disposed += 1;
    },
  }));

  const started = Date.now();
  const value = await adapter.run(request(), {});

  assert.equal(value.status, 'failed');
  assert.equal(value.task_id, 'TASK-1');
  assert.match(value.summary, /timed out/i);
  assert.equal(disposed, 1);
  assert.ok(Date.now() - started < 10_000, 'the worker must return in bounded time');
});

test('a failing dispose does not mask the worker result', async () => {
  let disposed = 0;
  const adapter = adapterWith(async (spec) => ({
    childId: String(spec.childId),
    result: Promise.resolve({
      output: [],
      structured: completedStructured,
      stopReason: 'completed',
    }),
    dispose: async () => {
      disposed += 1;
      throw new Error('dispose exploded');
    },
  }));

  const value = await adapter.run(request(), {});

  assert.equal(value.status, 'completed');
  assert.equal(disposed, 1);
});

test('a caller abort returns a failed result instead of waiting for the activation', { timeout: 15_000 }, async () => {
  let disposed = 0;
  const adapter = adapterWith(async (spec) => ({
    childId: String(spec.childId),
    // The provider never settles even though the caller aborted.
    result: new Promise(() => {}),
    dispose: async () => {
      disposed += 1;
    },
  }));
  const caller = new AbortController();
  caller.abort(new Error('user cancelled'));

  const value = await adapter.run(request(), { signal: caller.signal });

  assert.equal(value.status, 'failed');
  assert.match(value.summary, /aborted/i);
  assert.equal(disposed, 1);
});

test('a late activation rejection after the timeout is handled', { timeout: 15_000 }, async () => {
  let rejectLate: ((error: Error) => void) | undefined;
  const adapter = adapterWith(async (spec) => {
    const signal = spec.signal as AbortSignal;
    const result = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    signal.addEventListener('abort', () => {
      setTimeout(() => rejectLate?.(new Error('late activation failure')), 25);
    }, { once: true });
    return {
      childId: String(spec.childId),
      result,
      dispose: async () => {},
    };
  });

  const value = await adapter.run(request(), {});

  assert.equal(value.status, 'failed');
  assert.match(value.summary, /timed out/i);
  // Give the late rejection a chance to surface as an unhandled rejection.
  await new Promise((resolve) => setTimeout(resolve, 150));
});
