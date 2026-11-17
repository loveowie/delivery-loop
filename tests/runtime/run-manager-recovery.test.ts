import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState, TaskNode } from '../../src/domain/types.js';
import { DeliveryRunManager } from '../../src/runtime/run-manager.js';
import { RunRegistry } from '../../src/runtime/run-registry.js';
import { StateStore } from '../../src/state/state-store.js';

function task(): TaskNode {
  return {
    id: 'TASK-1',
    type: 'implementation',
    title: 'task',
    status: 'RUNNING',
    priority: 'normal',
    risk: 'low',
    origin: 'initial_plan',
    depends_on: [],
    requirement_ids: [],
    acceptance_ids: [],
    scope_paths: ['src'],
    required_outputs: [],
    worker_role: 'implementer',
    capability_profile: 'portable',
    attempt: 0,
    max_attempts: 3,
    verification_commands: ['npm test'],
    review_policy: 'none',
  };
}

function state(repo: string): RunState {
  return {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'RUNNING',
    repo_root: repo,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-1', tasks: [task()] },
    current_task_ids: ['TASK-1'],
    pause_requested: false,
    pending_decision_ids: [],
  };
}

test('wake recovers an orphaned RUNNING run and reschedules its in-flight task', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-recovery-'));
  const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'delivery-loop-registry-')));
  const store = await StateStore.open(repo);
  await store.createRun(state(repo));
  await registry.register('run-1', repo);
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    registry,
    runtimeFactory: {
      async create() {
        return {
          store,
          evidenceLedger: undefined,
          controller: {
            async start() {
              return (await store.readRun('run-1'))!;
            },
            async tick() {
              return await store.updateRun('run-1', (draft) => {
                draft.graph.tasks[0]!.status = 'DONE';
                draft.current_task_ids = [];
                draft.status = 'COMPLETED';
                return draft;
              });
            },
            async cancel() {
              return (await store.readRun('run-1'))!;
            },
          },
        };
      },
    } as never,
    sleep: async () => {},
  });

  const handle = await manager.get('run-1', repo);
  await manager.wake(handle);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await store.readRun('run-1'))?.status === 'COMPLETED') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const final = (await store.readRun('run-1'))!;
  assert.equal(final.status, 'COMPLETED');
  assert.equal(final.graph.tasks[0]?.status, 'DONE');
  const events = await readFile(join(store.getRunDirectory('run-1'), 'events.jsonl'), 'utf8');
  assert.match(events, /run_recovered/);
});

test('a live worker lock prevents a second controller from launching the run', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-ownership-'));
  const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'delivery-loop-registry-')));
  const store = await StateStore.open(repo);
  await store.createRun(state(repo));
  await registry.register('run-1', repo);
  const { acquireWorkerLock } = await import('../../src/runtime/worker-lock.js');
  const held = await acquireWorkerLock(repo, 'run-1');
  assert.equal(held.acquired, true);
  let started = false;
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    registry,
    runtimeFactory: {
      async create() {
        return {
          store,
          evidenceLedger: undefined,
          controller: {
            async start() { started = true; return (await store.readRun('run-1'))!; },
            async tick() { return (await store.readRun('run-1'))!; },
            async cancel() { return (await store.readRun('run-1'))!; },
          },
        };
      },
    } as never,
    sleep: async () => {},
  });

  try {
    const handle = await manager.get('run-1', repo);
    await manager.wake(handle);
    assert.equal(started, false);
    assert.equal((await store.readRun('run-1'))?.status, 'RUNNING');
  } finally {
    await held.release();
  }
});
