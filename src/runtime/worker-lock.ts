import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

export interface WorkerLock {
  acquired: boolean;
  release(): Promise<void>;
}

export async function hasActiveWorkerLock(repoRoot: string, runId: string): Promise<boolean> {
  const directory = join(repoRoot, '.delivery', 'runs', runId);
  const path = join(directory, 'worker.lock');
  try {
    // Key the lock by its own path, not by the run directory. proper-lockfile
    // keeps a process-global map keyed by the `file` argument, so using the run
    // directory here collides with StateStore's state lock on the same
    // directory and silently overwrites ownership.
    return await lockfile.check(path, {
      realpath: false,
      lockfilePath: path,
      stale: 30_000,
    });
  } catch (error) {
    // A missing run directory means no owner. Any other failure means we
    // cannot prove there is no owner, so fail closed rather than admitting a
    // second controller for the same run.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export async function acquireWorkerLock(repoRoot: string, runId: string): Promise<WorkerLock> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
  const directory = join(repoRoot, '.delivery', 'runs', runId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'worker.lock');
  try {
    const release = await lockfile.lock(path, {
      realpath: false,
      lockfilePath: path,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 0 },
    });
    return { acquired: true, release };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      return { acquired: false, release: async () => {} };
    }
    throw error;
  }
}
