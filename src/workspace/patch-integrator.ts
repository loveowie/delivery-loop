import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { GitApproval, GitCommandResult, GitExecutionOptions } from './git-adapter.js';

export interface PatchExecutor {
  exec(
    args: string[],
    cwd?: string,
    approval?: GitApproval,
    options?: GitExecutionOptions,
  ): Promise<GitCommandResult>;
}

export interface PatchArtifact {
  path: string;
  sha256: string;
}

export interface IntegrationResult {
  ok: boolean;
  error?: string;
}

export interface DeltaExportOptions {
  requireFrozenBase?: boolean;
}

export class PatchIntegrator {
  constructor(private readonly executor: PatchExecutor) {}

  private async indexPaths(worktree: string): Promise<{ live: string; frozen: string }> {
    const result = await this.executor.exec(['rev-parse', '--git-path', 'index'], worktree);
    const indexValue = result.stdout.trim();
    const live = isAbsolute(indexValue) ? indexValue : resolve(worktree, indexValue);
    return { live, frozen: join(resolve(live, '..'), 'delivery-loop-seed-index') };
  }

  async freezeDeltaBase(worktree: string): Promise<void> {
    const { live, frozen } = await this.indexPaths(worktree);
    await copyFile(live, frozen);
  }

  private filteredUntrackedFiles(files: string[]): string[] {
    return files.filter((file) => file !== '.delivery' && !file.startsWith('.delivery/'));
  }

  private async withTemporaryIndex<T>(
    worktree: string,
    initialize: (indexPath: string) => Promise<void>,
    run: (indexPath: string) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'delivery-loop-index-'));
    const indexPath = join(directory, 'index');
    try {
      await initialize(indexPath);
      return await run(indexPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async addIntentToAdd(
    worktree: string,
    files: string[],
    approval: GitApproval | undefined,
    indexPath: string,
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }
    await this.executor.exec(['add', '-N', '--', ...files], worktree, approval, {
      env: { GIT_INDEX_FILE: indexPath },
    });
  }

  private async indexFiles(
    worktree: string,
    approval: GitApproval | undefined,
    indexPath: string,
  ): Promise<string[]> {
    const result = await this.executor.exec(
      ['ls-files', '-z'],
      worktree,
      approval,
      { env: { GIT_INDEX_FILE: indexPath } },
    );
    return result.stdout.split('\0').filter(Boolean);
  }

  private async filesAddedSinceBase(
    worktree: string,
    approval: GitApproval | undefined,
    baseIndexPath: string,
  ): Promise<string[]> {
    const { live } = await this.indexPaths(worktree);
    const [baseFiles, liveFiles] = await Promise.all([
      this.indexFiles(worktree, approval, baseIndexPath),
      this.indexFiles(worktree, approval, live),
    ]);
    const base = new Set(baseFiles);
    return this.filteredUntrackedFiles(liveFiles.filter((file) => !base.has(file)));
  }

  async exportTaskPatch(
    worktree: string,
    baselineCommit: string,
    outputDirectory: string,
    untrackedFiles: string[],
    approval?: GitApproval,
  ): Promise<PatchArtifact> {
    const files = this.filteredUntrackedFiles(untrackedFiles);
    const content = await this.withTemporaryIndex(
      worktree,
      async (indexPath) => {
        await this.executor.exec(['read-tree', baselineCommit], worktree, approval, {
          env: { GIT_INDEX_FILE: indexPath },
        });
      },
      async (indexPath) => {
        const addedFiles = await this.filesAddedSinceBase(worktree, approval, indexPath);
        await this.addIntentToAdd(
          worktree,
          [...new Set([...files, ...addedFiles])],
          approval,
          indexPath,
        );
        return (
          await this.executor.exec(
            ['diff', '--binary', '--no-ext-diff', baselineCommit],
            worktree,
            approval,
            { env: { GIT_INDEX_FILE: indexPath } },
          )
        ).stdout;
      },
    );
    const path = join(outputDirectory, 'delivery.patch');
    await writeFile(path, content, 'utf8');
    const { createHash } = await import('node:crypto');
    return { path, sha256: createHash('sha256').update(content).digest('hex') };
  }

  async exportDeltaPatch(
    worktree: string,
    outputDirectory: string,
    untrackedFiles: string[],
    approval?: GitApproval,
    options?: DeltaExportOptions,
  ): Promise<PatchArtifact> {
    const files = this.filteredUntrackedFiles(untrackedFiles);
    const content = await this.withTemporaryIndex(
      worktree,
      async (indexPath) => {
        const { live, frozen } = await this.indexPaths(worktree);
        let sourceIndex = live;
        try {
          await access(frozen);
          sourceIndex = frozen;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
          if (options?.requireFrozenBase === true) {
            throw new Error(`frozen delta base is missing for managed worktree: ${worktree}`);
          }
        }
        await copyFile(sourceIndex, indexPath);
      },
      async (indexPath) => {
        const addedFiles = await this.filesAddedSinceBase(worktree, approval, indexPath);
        await this.addIntentToAdd(
          worktree,
          [...new Set([...files, ...addedFiles])],
          approval,
          indexPath,
        );
        return (
          await this.executor.exec(
            ['diff', '--binary', '--no-ext-diff'],
            worktree,
            approval,
            { env: { GIT_INDEX_FILE: indexPath } },
          )
        ).stdout;
      },
    );
    const path = join(outputDirectory, 'task.patch');
    await writeFile(path, content, 'utf8');
    const { createHash } = await import('node:crypto');
    return {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  async applyToIntegration(
    integrationWorktree: string,
    patchPath: string,
    approval: GitApproval,
  ): Promise<IntegrationResult> {
    try {
      if ((await readFile(patchPath)).length === 0) {
        return { ok: true };
      }
      await this.executor.exec(
        ['apply', '--whitespace=nowarn', patchPath],
        integrationWorktree,
        approval,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
