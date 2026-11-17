import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState, RunStatus } from '../../src/domain/types.js';
import { DeliveryRunManager, drainRepositoryQueue } from '../../src/runtime/run-manager.js';
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

test('repository queue promotes queued runs in FIFO order after the active owner exits', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-queue-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'active', 'RUNNING', '2026-11-03T00:00:00Z'));
  await store.createRun(runState(repo, 'queued-1', 'QUEUED', '2026-11-03T00:00:01Z'));
  await store.createRun(runState(repo, 'queued-2', 'QUEUED', '2026-11-03T00:00:02Z'));
  const launched: string[] = [];

  await drainRepositoryQueue(store, async (state) => {
    launched.push(state.run_id);
  });
  assert.equal(launched.length, 0);

  await store.updateRun('active', (state) => ({ ...state, status: 'COMPLETED' }));
  await Promise.all([
    drainRepositoryQueue(store, async (state) => { launched.push(state.run_id); }),
    drainRepositoryQueue(store, async (state) => { launched.push(state.run_id); }),
  ]);

  assert.deepEqual(launched, ['queued-1']);
  assert.equal((await store.readRun('queued-1'))?.status, 'PLANNING');
  assert.equal((await store.readRun('queued-2'))?.status, 'QUEUED');

  await store.updateRun('queued-1', (state) => ({ ...state, status: 'COMPLETED' }));
  await drainRepositoryQueue(store, async (state) => { launched.push(state.run_id); });

  assert.deepEqual(launched, ['queued-1', 'queued-2']);
});

test('queued runs do not consume repository write capacity', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-queue-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'queued-1', 'QUEUED', '2026-11-03T00:00:00Z', 2));
  await store.createRun(runState(repo, 'queued-2', 'QUEUED', '2026-11-03T00:00:01Z', 2));
  const launched: string[] = [];

  await drainRepositoryQueue(store, async (state) => { launched.push(state.run_id); });

  assert.deepEqual(launched, ['queued-1', 'queued-2']);
});

test('read loads persisted state without constructing or launching a runtime', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-read-'));
  const registryHome = await mkdtemp(join(tmpdir(), 'delivery-loop-registry-'));
  const registry = new RunRegistry(registryHome);
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'run-1', 'BLOCKED', '2026-11-03T00:00:00Z'));
  await registry.register('run-1', repo);
  let runtimeCreates = 0;
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    registry,
    runtimeFactory: {
      async create() {
        runtimeCreates += 1;
        throw new Error('runtime construction must not happen during read');
      },
    } as never,
  });

  const result = await manager.read('run-1');

  assert.equal(result.state.status, 'BLOCKED');
  assert.equal(result.repoRoot, repo);
  assert.equal(runtimeCreates, 0);
});

test('foreground completion automatically starts the next queued run', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-foreground-'));
  const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'delivery-loop-registry-')));
  let releaseFirstTick!: () => void;
  const firstTick = new Promise<void>((resolve) => { releaseFirstTick = resolve; });
  const preparedRunFactory = {
    async create(input: { run_id?: string }) {
      const runId = input.run_id!;
      const store = await StateStore.open(repo);
      const createdAt = new Date(Date.now() + (runId === 'run-1' ? 0 : 1)).toISOString();
      const state = runState(
        repo,
        runId,
        'PLANNING',
        createdAt,
      );
      await store.createRun(state);
      return state;
    },
  };
  const runtimeFactory = {
    async create(_repoRoot: string, runId: string) {
      const store = await StateStore.open(repo);
      return {
        store,
        controller: {
          async start() {
            return await store.updateRun(runId, (state) => ({ ...state, status: 'RUNNING' }));
          },
          async tick() {
            if (runId === 'run-1') {
              await firstTick;
            }
            return await store.updateRun(runId, (state) => ({ ...state, status: 'COMPLETED' }));
          },
        },
      };
    },
  };
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    preparedRunFactory: preparedRunFactory as never,
    runtimeFactory: runtimeFactory as never,
    registry,
    sleep: async () => {},
  });

  await manager.start({ repo_root: repo, prepared_directory: repo, run_id: 'run-1' });
  const second = await manager.start({ repo_root: repo, prepared_directory: repo, run_id: 'run-2' });
  assert.equal(second.state.status, 'QUEUED');

  releaseFirstTick();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await second.store.readRun('run-2'))?.status === 'COMPLETED') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal((await second.store.readRun('run-2'))?.status, 'COMPLETED');
});

test('cancelling an in-flight foreground owner does not admit the next run before exit', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-cancel-'));
  const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'delivery-loop-registry-')));
  let releaseFirstTick!: () => void;
  const firstTick = new Promise<void>((resolve) => { releaseFirstTick = resolve; });
  let firstTickEntered!: () => void;
  const entered = new Promise<void>((resolve) => { firstTickEntered = resolve; });
  let secondStarted = false;
  let inFlight = 0;
  let maximumInFlight = 0;
  const preparedRunFactory = {
    async create(input: { run_id?: string }) {
      const runId = input.run_id!;
      const store = await StateStore.open(repo);
      const state = runState(repo, runId, 'PLANNING', new Date().toISOString());
      await store.createRun(state);
      return state;
    },
  };
  const runtimeFactory = {
    async create(_repoRoot: string, runId: string) {
      const store = await StateStore.open(repo);
      return {
        store,
        controller: {
          async start() {
            if (runId === 'run-2') {
              secondStarted = true;
            }
            return await store.updateRun(runId, (state) => ({ ...state, status: 'RUNNING' }));
          },
          async tick() {
            inFlight += 1;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
            try {
              if (runId === 'run-1') {
                firstTickEntered();
                await firstTick;
              }
              const current = await store.readRun(runId);
              if (current?.status === 'CANCELLED') {
                return current;
              }
              return await store.updateRun(runId, (state) => ({ ...state, status: 'COMPLETED' }));
            } finally {
              inFlight -= 1;
            }
          },
          async cancel() {
            return await store.updateRun(runId, (state) => ({ ...state, status: 'CANCELLED' }));
          },
        },
      };
    },
  };
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    preparedRunFactory: preparedRunFactory as never,
    runtimeFactory: runtimeFactory as never,
    registry,
    sleep: async () => {},
  });

  const first = await manager.start({ repo_root: repo, prepared_directory: repo, run_id: 'run-1' });
  const second = await manager.start({ repo_root: repo, prepared_directory: repo, run_id: 'run-2' });
  await entered;
  first.state = await first.controller.cancel('run-1');
  await manager.wake(first);

  assert.equal(secondStarted, false);
  assert.equal((await second.store.readRun('run-2'))?.status, 'QUEUED');
  assert.equal(maximumInFlight, 1);

  releaseFirstTick();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await second.store.readRun('run-2'))?.status === 'COMPLETED') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal((await second.store.readRun('run-2'))?.status, 'COMPLETED');
  assert.equal(maximumInFlight, 1);
});

test('wake during an exiting foreground loop requeues the resumed run after ownership closes', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-resume-'));
  const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'delivery-loop-registry-')));
  let releaseTick!: () => void;
  const tickRelease = new Promise<void>((resolve) => { releaseTick = resolve; });
  let tickEntered!: () => void;
  const entered = new Promise<void>((resolve) => { tickEntered = resolve; });
  let ticks = 0;
  const preparedRunFactory = {
    async create(input: { run_id?: string }) {
      const store = await StateStore.open(repo);
      const state = runState(repo, input.run_id!, 'PLANNING', new Date().toISOString());
      await store.createRun(state);
      return state;
    },
  };
  const runtimeFactory = {
    async create(_repoRoot: string, runId: string) {
      const store = await StateStore.open(repo);
      return {
        store,
        controller: {
          async start() {
            return await store.updateRun(runId, (state) => ({ ...state, status: 'RUNNING' }));
          },
          async tick() {
            ticks += 1;
            if (ticks === 1) {
              tickEntered();
              await tickRelease;
              return { ...(await store.readRun(runId))!, status: 'WAITING_HUMAN' as const };
            }
            return await store.updateRun(runId, (state) => ({ ...state, status: 'COMPLETED' }));
          },
        },
      };
    },
  };
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    preparedRunFactory: preparedRunFactory as never,
    runtimeFactory: runtimeFactory as never,
    registry,
    sleep: async () => {},
  });

  const handle = await manager.start({ repo_root: repo, prepared_directory: repo, run_id: 'run-1' });
  await entered;
  handle.state = await handle.store.updateRun('run-1', (state) => ({ ...state, status: 'RUNNING' }));
  await manager.wake(handle);
  assert.equal(ticks, 1);

  releaseTick();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await handle.store.readRun('run-1'))?.status === 'COMPLETED') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal((await handle.store.readRun('run-1'))?.status, 'COMPLETED');
  assert.equal(ticks, 2);
});
