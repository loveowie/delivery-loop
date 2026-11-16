import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { assertSafePath, durableWrite } from './state-store.js';
import type { EvidenceRecord } from '../domain/types.js';

export class EvidenceLedger {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  private path(runId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
      throw new Error(`invalid run id: ${runId}`);
    }
    return join(this.repoRoot, '.delivery', 'runs', runId, 'evidence', 'index.json');
  }

  async readAll(runId?: string): Promise<EvidenceRecord[]> {
    if (runId === undefined) {
      const { readdir } = await import('node:fs/promises');
      const runsRoot = join(this.repoRoot, '.delivery', 'runs');
      try {
        const entries = await readdir(runsRoot, { withFileTypes: true });
        const results: EvidenceRecord[] = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            results.push(...(await this.readAll(entry.name)));
          }
        }
        return results;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw error;
      }
    }
    try {
      await assertSafePath(join(this.repoRoot, '.delivery'), this.path(runId));
      return JSON.parse(await readFile(this.path(runId), 'utf8')) as EvidenceRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async append(record: EvidenceRecord): Promise<void> {
    const path = this.path(record.run_id);
    const directory = join(path, '..');
    await assertSafePath(join(this.repoRoot, '.delivery'), path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(directory, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 400, factor: 1, minTimeout: 10, maxTimeout: 25 },
    });
    try {
      const records = await this.readAll(record.run_id);
      const next = records.filter((candidate) => candidate.id !== record.id);
      next.push(record);
      await durableWrite(path, `${JSON.stringify(next, null, 2)}\n`);
    } finally {
      await release();
    }
  }
}
