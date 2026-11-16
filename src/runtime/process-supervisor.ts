import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

export type ProcessOutcome = 'exited' | 'aborted' | 'timed_out';

export interface SupervisedProcessRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  terminationGraceMs: number;
  stdoutPath: string;
  stderrPath: string;
  signal?: AbortSignal;
}

export interface SupervisedProcessResult {
  outcome: ProcessOutcome;
  exitCode: number;
  signal: NodeJS.Signals | null;
  pid: number;
  logsFlushed: true;
}

function processGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalProcess(pid: number, childKill: (signal: NodeJS.Signals) => boolean, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') childKill(signal);
    else process.kill(-pid, signal);
  } catch {
    // The process or process group already exited.
  }
}

export async function runSupervisedProcess(
  request: SupervisedProcessRequest,
): Promise<SupervisedProcessResult> {
  if (request.signal?.aborted) {
    throw new Error('worker aborted before spawn');
  }
  await Promise.all([
    writeFile(request.stdoutPath, '', 'utf8'),
    writeFile(request.stderrPath, '', 'utf8'),
  ]);

  return await new Promise<SupervisedProcessResult>((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: request.env ?? process.env,
      detached: process.platform !== 'win32',
    });
    const pid = child.pid;
    if (pid === undefined) {
      child.once('error', reject);
      return;
    }

    const stdout = createWriteStream(request.stdoutPath, { flags: 'a' });
    const stderr = createWriteStream(request.stderrPath, { flags: 'a' });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);

    let outcome: ProcessOutcome = 'exited';
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let closed = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    let groupPollTimer: NodeJS.Timeout | undefined;
    let terminationDeadline = 0;

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (groupPollTimer) clearTimeout(groupPollTimer);
      request.signal?.removeEventListener('abort', onAbort);
    };

    const finish = async (): Promise<void> => {
      if (settled || !closed) return;
      if (processGroupAlive(pid)) return;
      settled = true;
      cleanup();
      try {
        await Promise.all([finished(stdout), finished(stderr)]);
        resolve({
          outcome,
          exitCode: outcome === 'aborted' ? 130 : outcome === 'timed_out' ? 124 : (closeCode ?? 1),
          signal: closeSignal,
          pid,
          logsFlushed: true,
        });
      } catch (error) {
        reject(error);
      }
    };

    const pollForGroupExit = (): void => {
      if (settled) return;
      if (!processGroupAlive(pid)) {
        void finish();
        return;
      }
      if (Date.now() >= terminationDeadline) {
        settled = true;
        cleanup();
        stdout.destroy();
        stderr.destroy();
        reject(new Error(`process group ${pid} remained alive after SIGKILL`));
        return;
      }
      groupPollTimer = setTimeout(pollForGroupExit, 10);
      groupPollTimer.unref();
    };

    const terminateProcessGroup = (): void => {
      signalProcess(pid, (nextSignal) => child.kill(nextSignal), 'SIGTERM');
      escalationTimer = setTimeout(() => {
        signalProcess(pid, (nextSignal) => child.kill(nextSignal), 'SIGKILL');
        terminationDeadline = Date.now() + Math.max(request.terminationGraceMs, 1_000);
        pollForGroupExit();
      }, request.terminationGraceMs);
      escalationTimer.unref();
    };

    const terminate = (nextOutcome: Exclude<ProcessOutcome, 'exited'>): void => {
      if (outcome !== 'exited' || settled) return;
      outcome = nextOutcome;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      terminateProcessGroup();
    };

    const onAbort = (): void => terminate('aborted');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    timeoutTimer = setTimeout(() => terminate('timed_out'), request.timeoutMs);
    timeoutTimer.unref();

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.destroy();
      stderr.destroy();
      reject(error);
    });
    child.once('close', (code, signal) => {
      closed = true;
      closeCode = code;
      closeSignal = signal;
      if (outcome === 'exited' && processGroupAlive(pid)) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        terminateProcessGroup();
        return;
      }
      if (!processGroupAlive(pid)) {
        void finish();
      }
    });
  });
}
