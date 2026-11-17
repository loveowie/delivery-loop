import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

interface RegistryEntry {
  repo_root: string;
  registered_at: string;
}

interface RegistryData {
  version: 1;
  runs: Record<string, RegistryEntry>;
}

export class RunRegistry {
  private readonly path: string;
  private readonly home: string;

  constructor(home = process.env.DELIVERY_LOOP_HOME ?? join(homedir(), '.delivery-loop')) {
    this.home = home;
    this.path = join(home, 'runs.json');
  }

  private async read(): Promise<RegistryData> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as RegistryData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, runs: {} };
      }
      throw error;
    }
  }

  private async write(data: RegistryData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
  }

  async register(runId: string, repoRoot: string): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.home, {
      realpath: false,
      lockfilePath: join(this.home, 'registry.lock'),
      stale: 30_000,
      update: 10_000,
      retries: { retries: 400, factor: 1, minTimeout: 10, maxTimeout: 25 },
    });
    try {
      const data = await this.read();
      data.runs[runId] = { repo_root: repoRoot, registered_at: new Date().toISOString() };
      await this.write(data);
    } finally {
      await release();
    }
  }

  async lookup(runId: string): Promise<string | undefined> {
    return (await this.read()).runs[runId]?.repo_root;
  }

  async list(): Promise<Array<{ run_id: string; repo_root: string; registered_at: string }>> {
    const data = await this.read();
    return Object.entries(data.runs)
      .map(([runId, entry]) => ({ run_id: runId, ...entry }))
      .sort((left, right) => right.registered_at.localeCompare(left.registered_at));
  }
}
