import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafePath, durableWrite } from '../state/state-store.js';

export class EvidenceStore {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  async write(
    runId: string,
    evidenceId: string,
    stream: 'stdout' | 'stderr',
    content: string,
  ): Promise<string> {
    if (![runId,evidenceId].every(id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) {
      throw new Error('invalid evidence path');
    }
    const directory = join(this.repoRoot, '.delivery', 'runs', runId, 'evidence');
    await assertSafePath(join(this.repoRoot, '.delivery'), join(directory, `${evidenceId}.${stream}.log`));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${evidenceId}.${stream}.log`);
    await durableWrite(path, content);
    return path;
  }
}
