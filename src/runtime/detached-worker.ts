import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { hasActiveWorkerLock } from './worker-lock.js';

export interface DetachedWorkerLaunchOptions {
  workerPath?: string;
  readyTimeoutMs?: number;
  terminationGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface WorkerStartupMessage {
  type: 'ready' | 'error';
  run_id: string;
  phase?: 'runtime_initialized';
  message?: string;
}

function startupMessage(value: unknown): WorkerStartupMessage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if ((candidate.type !== 'ready' && candidate.type !== 'error') || typeof candidate.run_id !== 'string') {
    return undefined;
  }
  return {
    type: candidate.type,
    run_id: candidate.run_id,
    ...(candidate.phase === 'runtime_initialized' ? { phase: candidate.phase } : {}),
    ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
  };
}

async function terminateBeforeReady(
  child: ReturnType<typeof spawn>,
  graceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const escalation = setTimeout(() => child.kill('SIGKILL'), graceMs);
  escalation.unref();
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  clearTimeout(escalation);
}

export async function launchDetachedWorker(
  repoRoot: string,
  runId: string,
  pluginRoot: string,
  options: DetachedWorkerLaunchOptions = {},
): Promise<void> {
  if (await hasActiveWorkerLock(repoRoot, runId)) {
    return;
  }
  const child = spawn(
    process.execPath,
    [options.workerPath ?? join(pluginRoot, 'dist', 'worker.js'), '--repo', repoRoot, '--run', runId, '--plugin-root', pluginRoot],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: options.env ?? process.env,
    },
  );
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminateBeforeReady(child, terminationGraceMs).then(
        () => reject(error),
        (terminationError) => reject(terminationError),
      );
    };
    const onMessage = (value: unknown): void => {
      const message = startupMessage(value);
      if (message === undefined || message.run_id !== runId) return;
      if (message.type === 'error') {
        fail(new Error(message.message ?? `detached worker ${runId} failed during startup`));
        return;
      }
      if (message.phase !== 'runtime_initialized') return;
      if (settled) return;
      settled = true;
      cleanup();
      child.disconnect();
      resolve();
    };
    const onError = (error: Error): void => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      fail(new Error(`detached worker ${runId} exited before ready with code ${code ?? 'null'}${signal === null ? '' : ` signal ${signal}`}`));
    };
    const timeout = setTimeout(
      () => fail(new Error(`detached worker ${runId} ready handshake timeout after ${readyTimeoutMs}ms`)),
      readyTimeoutMs,
    );
    timeout.unref();
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  child.unref();
}
