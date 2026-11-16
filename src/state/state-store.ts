import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { RunStateSchema } from '../domain/schemas.js';
import type { RunState } from '../domain/types.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
}

function runDirectory(repoRoot: string, runId: string): string {
  assertRunId(runId);
  return join(repoRoot, '.delivery', 'runs', runId);
}

export async function assertSafePath(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('runtime path escapes run directory');
  let current = root;
  for (const segment of ['', ...rel.split('/').filter(Boolean)]) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`runtime path cannot contain a symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function durableWrite(target: string, content: string, exclusive = false): Promise<void> {
  const temporary = exclusive ? target : `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, exclusive ? 'wx' : 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    if (!exclusive) await rename(temporary, target);
    const directory = await open(dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (!exclusive) await rm(temporary, { force: true });
  }
}

export class StateStore {
  readonly repoRoot: string;

  private constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  static async open(repoRoot: string): Promise<StateStore> {
    const store = new StateStore(repoRoot);
    const deliveryRoot = join(repoRoot, '.delivery');
    try {
      const details = await lstat(deliveryRoot);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error('delivery runtime path must be a real directory, not a symlink');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(deliveryRoot, { recursive: true, mode: 0o700 });
      } else {
        throw error;
      }
    }
    await assertSafePath(deliveryRoot, join(deliveryRoot, 'runs'));
    await mkdir(join(deliveryRoot, 'runs'), { recursive: true, mode: 0o700 });
    return store;
  }

  getRunDirectory(runId: string): string {
    return runDirectory(this.repoRoot, runId);
  }

  async createRun(state: RunState): Promise<RunState> {
    const directory = this.getRunDirectory(state.run_id);
    await assertSafePath(join(this.repoRoot, '.delivery'), directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    state = { ...state, revision: 0 };
    const path = join(directory, 'run.json');
    const content = `${JSON.stringify(state, null, 2)}\n`;
    try {
      await durableWrite(path, content, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`run already exists: ${state.run_id}`);
      }
      throw error;
    }
    return structuredClone(state);
  }

  async readRun(runId: string): Promise<RunState | undefined> {
    try {
      const path = join(this.getRunDirectory(runId), 'run.json');
      await assertSafePath(join(this.repoRoot, '.delivery'), path);
      const content = await readFile(path, 'utf8');
      const state = JSON.parse(content) as RunState;
      if (state.state_schema_version !== 1 || state.run_id !== runId || state.graph?.run_id !== runId) throw new Error('invalid or unsupported persisted run state');
      const parsed = RunStateSchema.safeParse(state);
      if (!parsed.success) throw new Error(`invalid persisted run state: ${parsed.error.message}`);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async listRuns(): Promise<RunState[]> {
    const { readdir } = await import('node:fs/promises');
    const root = join(this.repoRoot, '.delivery', 'runs');
    const entries = await readdir(root, { withFileTypes: true });
    const states: RunState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const state = await this.readRun(entry.name);
      if (state !== undefined) {
        states.push(state);
      }
    }
    return states.sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  async updateRun(
    runId: string,
    update: (current: RunState) => RunState | Promise<RunState>,
    options: { expectedRevision?: number } = {},
  ): Promise<RunState> {
    const release = await this.acquireStateLock(runId);
    try {
      const current = await this.readRun(runId);
      if (current === undefined) {
        throw new Error(`run not found: ${runId}`);
      }
      if (options.expectedRevision !== undefined && options.expectedRevision !== (current.revision ?? 0)) throw new Error('run revision conflict');
      const next = await update(structuredClone(current));
      const directory = this.getRunDirectory(runId);
      const target = join(directory, 'run.json');
      const content = `${JSON.stringify({ ...next, revision: (current.revision ?? 0) + 1, updated_at: new Date().toISOString() }, null, 2)}\n`;
      await durableWrite(target, content);
      return JSON.parse(content) as RunState;
    } finally {
      await release();
    }
  }

  private async acquireStateLock(runId: string): Promise<() => Promise<void>> {
    await assertSafePath(join(this.repoRoot, '.delivery'), this.getRunDirectory(runId));
    return await lockfile.lock(this.getRunDirectory(runId), {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: {
        retries: 400,
        factor: 1,
        minTimeout: 10,
        maxTimeout: 25,
      },
    });
  }

  async appendEvent(runId: string, event: Record<string, unknown>): Promise<void> {
    const directory = this.getRunDirectory(runId);
    await mkdir(directory, { recursive: true });
    await assertSafePath(join(this.repoRoot, '.delivery'), join(directory, 'events.jsonl'));
    const handle = await open(join(directory, 'events.jsonl'), 'a');
    try {
      await handle.write(
        `${JSON.stringify({ event_id: randomUUID(), timestamp: new Date().toISOString(), ...event })}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async readEvents(runId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    try {
      const content = await readFile(join(this.getRunDirectory(runId), 'events.jsonl'), 'utf8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .slice(-Math.max(0, limit));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async writeArtifact(runId: string, relativePath: string, content: string): Promise<string> {
    const directory = this.getRunDirectory(runId);
    const target = resolve(directory, relativePath);
    if (isAbsolute(relativePath) || target === directory) throw new Error('artifact path cannot escape the run directory');
    await assertSafePath(directory, target);
    await assertSafePath(join(this.repoRoot, '.delivery'), target);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await durableWrite(target, content);
    return target;
  }

  async removeTemporaryFiles(runId: string): Promise<void> {
    const directory = this.getRunDirectory(runId);
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(directory)) {
      if (name.endsWith('.tmp')) {
        await rm(join(directory, name), { force: true });
      }
    }
  }

  digest(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
