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

async function harness(
  repo: string,
  tick: (store: StateStore) => Promise<RunState>,
): Promise<{ store: StateStore; manager: DeliveryRunManager }> {
  const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'delivery-loop-transient-registry-')));
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
            async start() { return (await store.readRun('run-1'))!; },
            async tick() { return await tick(store); },
            async cancel() { return (await store.readRun('run-1'))!; },
          },
        };
      },
    } as never,
    sleep: async () => {},
  });
  return { store, manager };
}

async function eventsOf(store: StateStore): Promise<string> {
  return await readFile(join(store.getRunDirectory('run-1'), 'events.jsonl'), 'utf8');
}

async function waitForEvent(store: StateStore, pattern: RegExp): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const events = await eventsOf(store);
    if (pattern.test(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return await eventsOf(store);
}

async function waitForStatus(store: StateStore, status: string): Promise<RunState> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await store.readRun('run-1');
    if (current?.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return (await store.readRun('run-1'))!;
}

test('a teardown race on the worker parent re-queues the task instead of blocking', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-transient-'));
  let calls = 0;
  const { store, manager } = await harness(repo, async (target) => {
    calls += 1;
    if (calls === 1) throw new Error('cannot create effect on inactive context');
    return await target.updateRun('run-1', (draft) => {
      draft.graph.tasks[0]!.status = 'DONE';
      draft.current_task_ids = [];
      draft.status = 'COMPLETED';
      return draft;
    });
  });

  await manager.wake(await manager.get('run-1', repo));
  const final = await waitForStatus(store, 'COMPLETED');
  assert.equal(final.status, 'COMPLETED');
  assert.equal(final.graph.tasks[0]?.attempt, 1, 'the recovery consumes one attempt');
  const events = await eventsOf(store);
  assert.match(events, /worker_launch_retry/);
  assert.doesNotMatch(events, /"code":"runtime_error"/);
});

test('a non-transient tick failure still blocks the run', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-transient-fatal-'));
  const { store, manager } = await harness(repo, async () => {
    throw new Error('DSH subagent provider "spawn" is not registered');
  });

  await manager.wake(await manager.get('run-1', repo));
  const final = await waitForStatus(store, 'BLOCKED');
  assert.equal(final.status, 'BLOCKED');
  assert.match(final.last_error ?? '', /not registered/);
  const events = await waitForEvent(store, /"code":"runtime_error"/);
  assert.doesNotMatch(events, /worker_launch_retry/);
  assert.match(events, /"code":"runtime_error"/);
});

test('repeated teardown races stop at the bounded retry budget', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-transient-bounded-'));
  const { store, manager } = await harness(repo, async () => {
    throw new Error('cannot create effect on inactive context');
  });

  await manager.wake(await manager.get('run-1', repo));
  const final = await waitForStatus(store, 'BLOCKED');
  assert.equal(final.status, 'BLOCKED');
  const events = await waitForEvent(store, /"code":"runtime_error"/);
  const retries = events.match(/"code":"worker_launch_retry"/g) ?? [];
  assert.equal(retries.length, 2, 'exactly two automatic recoveries');
  assert.match(events, /"code":"runtime_error"/);
});
