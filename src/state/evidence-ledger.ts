import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
      const target = this.path(runId);
      await assertSafePath(join(this.repoRoot, '.delivery'), target);
      const details = await lstat(target);
      if (!details.isFile()) throw new Error('evidence index is not a regular file');
      if (details.size > 16 * 1024 * 1024) throw new Error('evidence index is too large');
      const parsed = JSON.parse(await readFile(target, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('evidence index must be an array');
      const evidenceDirectory = resolve(join(this.repoRoot, '.delivery', 'runs', runId, 'evidence'));
      const valid = parsed.filter((record): record is EvidenceRecord => {
        if (record === null || typeof record !== 'object') return false;
        const candidate = record as Partial<EvidenceRecord>;
        if (candidate.run_id !== runId) return false;
        if (typeof candidate.id !== 'string' || typeof candidate.command !== 'string') return false;
        if (typeof candidate.code_snapshot_id !== 'string') return false;
        if (!['passed', 'failed', 'error'].includes(candidate.result as string)) return false;
        if (!Array.isArray(candidate.acceptance_ids)) return false;
        for (const logPath of [candidate.stdout_path, candidate.stderr_path]) {
          if (logPath === undefined || logPath.length === 0) continue;
          if (typeof logPath !== 'string') return false;
          const resolved = resolve(isAbsolute(logPath) ? logPath : join(evidenceDirectory, logPath));
          const relativePath = relative(evidenceDirectory, resolved);
          if (relativePath.startsWith('..') || isAbsolute(relativePath)) return false;
        }
        return true;
      });
      return valid.slice(-10_000);
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
