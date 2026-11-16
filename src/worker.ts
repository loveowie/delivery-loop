#!/usr/bin/env node
import { recoverInterruptedRun } from './controller/recovery.js';
import { RuntimeFactory } from './runtime/runtime-factory.js';
import { acquireWorkerLock } from './runtime/worker-lock.js';
import { durationExceeded, progressSignature } from './runtime/loop-guards.js';
import { StateStore } from './state/state-store.js';
import { drainRepositoryQueue, queueRunForAdmission } from './runtime/run-manager.js';
import { launchDetachedWorker } from './runtime/detached-worker.js';

interface WorkerArguments {
  repoRoot: string;
  runId: string;
  pluginRoot: string;
}

function sendStartupMessage(message: Record<string, unknown>): void {
  const send = process.send as ((message: unknown) => boolean) | undefined;
  if (send !== undefined && process.connected) {
    send(message);
  }
}

function disconnectStartupChannel(): void {
  if (process.connected) process.disconnect?.();
}

function parseArguments(argv: string[]): WorkerArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('invalid worker arguments');
    }
    values.set(key, value);
  }
  const repoRoot = values.get('--repo');
  const runId = values.get('--run');
  const pluginRoot = values.get('--plugin-root');
  if (repoRoot === undefined || runId === undefined || pluginRoot === undefined) {
    throw new Error('worker requires --repo, --run and --plugin-root');
  }
  return { repoRoot, runId, pluginRoot };
}

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const lock = await acquireWorkerLock(args.repoRoot, args.runId);
  if (!lock.acquired) {
    sendStartupMessage({
      type: 'error',
      run_id: args.runId,
      message: `worker lock already held for ${args.runId}`,
    });
    disconnectStartupChannel();
    return;
  }
  let startupComplete = false;
  try {
    const store = await StateStore.open(args.repoRoot);
    let state = await store.readRun(args.runId);
    if (state === undefined) {
      throw new Error(`run not found: ${args.runId}`);
    }
    if (state.status === 'QUEUED') {
      await drainRepositoryQueue(
        store,
        async (candidate) => await launchDetachedWorker(
          args.repoRoot,
          candidate.run_id,
          args.pluginRoot,
        ),
      );
      state = (await store.readRun(args.runId)) ?? state;
      if (state.status === 'QUEUED') {
        sendStartupMessage({
          type: 'error',
          run_id: args.runId,
          message: `run ${args.runId} remains queued`,
        });
        disconnectStartupChannel();
        startupComplete = true;
        return;
      }
    }
    const runtime = await new RuntimeFactory({ pluginRoot: args.pluginRoot }).create(
      args.repoRoot,
      args.runId,
    );
    state = await recoverInterruptedRun(runtime.store, args.runId);
    if (state === undefined) {
      throw new Error(`run not found: ${args.runId}`);
    }
    sendStartupMessage({
      type: 'ready',
      run_id: args.runId,
      phase: 'runtime_initialized',
    });
    disconnectStartupChannel();
    startupComplete = true;
    if (state.status === 'PLANNING') {
      state = await runtime.controller.start(args.runId);
    }

    let previousProgress = progressSignature(state);
    let stagnantCycles = 0;
    while (['PLANNING', 'QUEUED', 'RUNNING', 'VERIFYING'].includes(state.status)) {
      if (durationExceeded(state)) {
        state = await runtime.store.updateRun(args.runId, (draft) => ({
          ...draft,
          status: 'BLOCKED',
          last_error: 'maximum run duration exceeded',
        }));
        break;
      }
      state = await runtime.controller.tick(args.runId);
      if (!['PLANNING', 'QUEUED', 'RUNNING', 'VERIFYING'].includes(state.status)) {
        break;
      }
      const currentProgress = progressSignature(state);
      stagnantCycles = currentProgress === previousProgress ? stagnantCycles + 1 : 0;
      previousProgress = currentProgress;
      if (stagnantCycles >= state.config.runtime.no_progress_cycles) {
        state = await runtime.store.updateRun(args.runId, (draft) => ({
          ...draft,
          status: 'BLOCKED',
          last_error: 'no progress detected',
        }));
        break;
      }
      await sleep(250);
    }
  } catch (error) {
    if (!startupComplete) {
      sendStartupMessage({
        type: 'error',
        run_id: args.runId,
        message: error instanceof Error ? error.message : String(error),
      });
      disconnectStartupChannel();
      startupComplete = true;
    }
    const store = await StateStore.open(args.repoRoot).catch(() => undefined);
    if (store !== undefined) {
      await store.updateRun(args.runId, (state) => ({
        ...state,
        status: 'BLOCKED',
        last_error: error instanceof Error ? error.message : String(error),
      })).catch(() => undefined);
      await store.appendEvent(args.runId, {
        type: 'worker_error',
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  } finally {
    await lock.release();
    const store = await StateStore.open(args.repoRoot).catch(() => undefined);
    if (store !== undefined) {
      const state = await store.readRun(args.runId).catch(() => undefined);
      if (
        state !== undefined &&
        ['PLANNING', 'RUNNING', 'VERIFYING'].includes(state.status) &&
        !state.pause_requested
      ) {
        await queueRunForAdmission(store, args.runId);
      }
      await drainRepositoryQueue(
        store,
        async (state) => await launchDetachedWorker(
          args.repoRoot,
          state.run_id,
          args.pluginRoot,
        ),
      ).catch(async (error) => {
        await store.appendEvent(args.runId, {
          type: 'queue_drain_error',
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      });
    }
  }
}

await main();
