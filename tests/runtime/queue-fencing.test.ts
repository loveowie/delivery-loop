import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState, RunStatus, TaskNode } from '../../src/domain/types.js';
import {
  DeliveryRunManager,
  drainRepositoryQueue,
  queueRunForAdmission,
} from '../../src/runtime/run-manager.js';
import { RunRegistry } from '../../src/runtime/run-registry.js';
import { StateStore } from '../../src/state/state-store.js';

function runState(
  repoRoot: string,
  runId: string,
  status: RunStatus,
  createdAt: string,
  maxActiveWriteRuns = 1,
): RunState {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.repository.max_active_write_runs = maxActiveWriteRuns;
  return {
    state_schema_version: 1,
    run_id: runId,
    status,
    repo_root: repoRoot,
    created_at: createdAt,
    updated_at: createdAt,
    config,
    graph: { run_id: runId, tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
}

function runningTask(id: string): TaskNode {
  return {
    id,
    type: 'implementation',
    title: id,
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
    verification_commands: [],
    review_policy: 'none',
  };
}

/**
 * A store facade that behaves exactly like a real StateStore except for the
 * hooks a test installs. It is used to place a cancel/complete between the
 * manager's snapshot read and its write, which is the race the fence exists
 * for.
 */
function storeFacade(store: StateStore): StateStore {
  return Object.create(store) as StateStore;
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && /run revision conflict/i.test(error.message);
}

test('a run cancelled after the queue snapshot is never admitted', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-fencing-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'queued-1', 'QUEUED', '2026-11-03T00:00:01Z'));
  await store.createRun(runState(repo, 'queued-2', 'QUEUED', '2026-11-03T00:00:02Z'));

  const facade = storeFacade(store);
  const originalListRuns = store.listRuns.bind(store);
  facade.listRuns = async () => {
    const snapshot = await originalListRuns();
    // The cancel lands after `listRuns` returned its snapshot and before the
    // admission write: exactly the window that used to resurrect the run.
    await store.updateRun('queued-1', (draft) => ({ ...draft, status: 'CANCELLED' }));
    return snapshot;
  };
  const originalUpdateRun = store.updateRun.bind(store);
  let revisionConflicts = 0;
  facade.updateRun = async (runId, update, options) => {
    try {
      return await originalUpdateRun(runId, update, options);
    } catch (error) {
      if (isRevisionConflict(error)) revisionConflicts += 1;
      throw error;
    }
  };

  const launched: string[] = [];
  await drainRepositoryQueue(facade, async (state) => { launched.push(state.run_id); });

  assert.deepEqual(launched, ['queued-2']);
  assert.equal((await store.readRun('queued-1'))?.status, 'CANCELLED');
  assert.equal((await store.readRun('queued-2'))?.status, 'PLANNING');
  // Admission must compare-and-swap on the revision it listed; the stale write
  // really conflicts and re-reads instead of blindly overwriting.
  assert.ok(revisionConflicts >= 1, 'admission must CAS on the listed revision');
});

test('a run completed after the queue snapshot is never demoted to PLANNING', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-fencing-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'queued-1', 'QUEUED', '2026-11-03T00:00:01Z'));

  const facade = storeFacade(store);
  const originalListRuns = store.listRuns.bind(store);
  facade.listRuns = async () => {
    const snapshot = await originalListRuns();
    await store.updateRun('queued-1', (draft) => ({ ...draft, status: 'COMPLETED' }));
    return snapshot;
  };

  const launched: string[] = [];
  await drainRepositoryQueue(facade, async (state) => { launched.push(state.run_id); });

  assert.deepEqual(launched, []);
  assert.equal((await store.readRun('queued-1'))?.status, 'COMPLETED');
});

test('queueRunForAdmission re-reads under the lock and refuses a cancelled run', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-fencing-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'run-1', 'RUNNING', '2026-11-03T00:00:01Z'));

  const facade = storeFacade(store);
  const originalReadRun = store.readRun.bind(store);
  let reads = 0;
  facade.readRun = async (runId) => {
    const state = await originalReadRun(runId);
    // Cancel between the admission's read and its write.
    if (runId === 'run-1' && reads === 0) {
      reads += 1;
      await store.updateRun(runId, (draft) => ({ ...draft, status: 'CANCELLED' }));
    }
    return state;
  };

  const result = await queueRunForAdmission(facade, 'run-1');

  assert.equal(result?.status, 'CANCELLED');
  assert.equal((await store.readRun('run-1'))?.status, 'CANCELLED');
});

test('queueRunForAdmission leaves a completed run completed', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-fencing-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'run-1', 'COMPLETED', '2026-11-03T00:00:01Z'));

  const result = await queueRunForAdmission(store, 'run-1');

  assert.equal(result?.status, 'COMPLETED');
  assert.equal((await store.readRun('run-1'))?.status, 'COMPLETED');
});

test('a corrupt run.json does not starve the repository queue', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-fencing-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'queued-1', 'QUEUED', '2026-11-03T00:00:01Z'));
  const broken = join(repo, '.delivery', 'runs', 'broken');
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, 'run.json'), '{ this is not valid json');

  const launched: string[] = [];
  const promoted = await drainRepositoryQueue(store, async (state) => {
    launched.push(state.run_id);
  });

  assert.deepEqual(launched, ['queued-1']);
  assert.deepEqual(promoted.map((state) => state.run_id), ['queued-1']);
  assert.equal((await store.readRun('queued-1'))?.status, 'PLANNING');
});

test('recovery never requeues a run that was cancelled after the recovery snapshot', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-fencing-'));
  const store = await StateStore.open(repo);
  const state = runState(repo, 'run-1', 'RUNNING', '2026-11-03T00:00:01Z');
  state.graph.tasks = [runningTask('TASK-1')];
  state.current_task_ids = ['TASK-1'];
  await store.createRun(state);

  const facade = storeFacade(store);
  const originalListRuns = store.listRuns.bind(store);
  let cancelled = false;
  facade.listRuns = async () => {
    const snapshot = await originalListRuns();
    if (!cancelled) {
      cancelled = true;
      await store.updateRun('run-1', (draft) => ({ ...draft, status: 'CANCELLED' }));
    }
    return snapshot;
  };

  let starts = 0;
  const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'delivery-loop-registry-')));
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    registry,
    runtimeFactory: {
      async create() {
        return {
          store: facade,
          evidenceLedger: undefined,
          controller: {
            async start() { starts += 1; return (await store.readRun('run-1'))!; },
            async tick() { return (await store.readRun('run-1'))!; },
            async cancel() { return (await store.readRun('run-1'))!; },
          },
        };
      },
    } as never,
    sleep: async () => {},
  });

  const handle = await manager.get('run-1', repo);
  await manager.wake(handle);

  assert.equal((await store.readRun('run-1'))?.status, 'CANCELLED');
  assert.equal(starts, 0);
});
