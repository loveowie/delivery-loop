import { access, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { RunState, TaskNode } from '../domain/types.js';
import type { TaskWorkspace, WorktreeProvider } from '../controller/delivery-controller.js';
import type { GitExecutor } from './git-adapter.js';
import type { PatchArtifact } from './patch-integrator.js';

interface SeedPatchIntegrator {
  freezeDeltaBase?(worktree: string): Promise<void>;
  exportTaskPatch(
    worktree: string,
    baselineCommit: string,
    outputDirectory: string,
    untrackedFiles: string[],
    approval?: { run_id: string },
  ): Promise<PatchArtifact>;
  exportDeltaPatch(
    worktree: string,
    outputDirectory: string,
    untrackedFiles: string[],
    approval?: { run_id: string },
    options?: { requireFrozenBase?: boolean },
  ): Promise<PatchArtifact>;
  applyToIntegration(
    integrationWorktree: string,
    patchPath: string,
    approval: { run_id: string },
  ): Promise<{ ok: boolean; error?: string }>;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`invalid worktree segment: ${value}`);
  }
  return value;
}

export class WorktreeManager implements WorktreeProvider {
  private readonly repoRoot: string;
  private readonly git: GitExecutor;
  private readonly patchIntegrator?: SeedPatchIntegrator;

  constructor(repoRoot: string, git: GitExecutor, patchIntegrator?: SeedPatchIntegrator) {
    this.repoRoot = repoRoot;
    this.git = git;
    if (patchIntegrator !== undefined) {
      this.patchIntegrator = patchIntegrator;
    }
  }

  taskPath(runId: string, taskId: string, attempt = 0): string {
    return join(
      this.repoRoot,
      '.delivery',
      'runs',
      safeSegment(runId),
      'worktrees',
      `${safeSegment(taskId)}-attempt-${attempt}`,
    );
  }

  integrationPath(runId: string): string {
    return join(
      this.repoRoot,
      '.delivery',
      'runs',
      safeSegment(runId),
      'worktrees',
      'integration-worktree',
    );
  }

  private async validateExistingWorktree(path: string, state: RunState): Promise<boolean> {
    try {
      await access(path);
    } catch {
      return false;
    }
    const expectedHead = state.baseline_commit ?? 'HEAD';
    const [rootResult, worktreeCommonResult, repoCommonResult, headResult, expectedResult] =
      await Promise.all([
        this.git.exec(['rev-parse', '--show-toplevel'], path),
        this.git.exec(['rev-parse', '--git-common-dir'], path),
        this.git.exec(['rev-parse', '--git-common-dir'], state.repo_root),
        this.git.exec(['rev-parse', 'HEAD'], path),
        this.git.exec(['rev-parse', expectedHead], state.repo_root),
      ]);
    const absoluteGitPath = (value: string, root: string) =>
      isAbsolute(value) ? resolve(value) : resolve(root, value);
    const root = await realpath(resolve(rootResult.stdout.trim()));
    const expectedRoot = await realpath(resolve(path));
    const worktreeCommon = await realpath(
      absoluteGitPath(worktreeCommonResult.stdout.trim(), root),
    );
    const repoCommon = await realpath(
      absoluteGitPath(repoCommonResult.stdout.trim(), state.repo_root),
    );
    if (
      root !== expectedRoot ||
      worktreeCommon !== repoCommon ||
      headResult.stdout.trim() !== expectedResult.stdout.trim()
    ) {
      throw new Error(`existing task worktree is invalid: ${path}`);
    }
    return true;
  }

  private async untrackedFiles(worktree: string): Promise<string[]> {
    const status = await this.git.exec(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      worktree,
    );
    return status.stdout
      .split('\0')
      .filter((entry) => entry.startsWith('?? '))
      .map((entry) => entry.slice(3))
      .filter((entry) => entry !== '.delivery' && !entry.startsWith('.delivery/'));
  }

  private async applySeedPatch(
    path: string,
    patch: PatchArtifact,
    state: RunState,
  ): Promise<void> {
    if (this.patchIntegrator === undefined) {
      return;
    }
    const applied = await this.patchIntegrator.applyToIntegration(
      path,
      patch.path,
      { run_id: state.run_id },
    );
    if (!applied.ok) {
      throw new Error(`failed to seed task worktree: ${applied.error ?? 'unknown error'}`);
    }
  }

  private async seedNewWorktree(
    path: string,
    state: RunState,
    task: TaskNode,
    seedFromWorktree: string | undefined,
  ): Promise<void> {
    if (this.patchIntegrator === undefined) {
      return;
    }
    const seedDirectory = join(
      this.repoRoot,
      '.delivery',
      'runs',
      safeSegment(state.run_id),
      'seed-patches',
      `${safeSegment(task.id)}-attempt-${task.attempt}`,
    );
    await mkdir(seedDirectory, { recursive: true });
    const acceptedSeed = state.integration_worktree;
    if (acceptedSeed !== undefined) {
      const acceptedPatch = await this.patchIntegrator.exportTaskPatch(
        acceptedSeed,
        state.baseline_commit ?? 'HEAD',
        seedDirectory,
        await this.untrackedFiles(acceptedSeed),
        { run_id: state.run_id },
      );
      await this.applySeedPatch(path, acceptedPatch, state);
      await this.git.exec(['add', '-A'], path, { run_id: state.run_id });
    }
    if (seedFromWorktree === undefined || seedFromWorktree === acceptedSeed) {
      return;
    }
    const untracked = await this.untrackedFiles(seedFromWorktree);
    const repairPatch = await this.patchIntegrator.exportDeltaPatch(
      seedFromWorktree,
      seedDirectory,
      untracked,
      { run_id: state.run_id },
      { requireFrozenBase: true },
    );
    await this.applySeedPatch(path, repairPatch, state);
    if (task.seed_worktree === undefined) {
      await this.git.exec(['add', '-A'], path, { run_id: state.run_id });
    }
  }

  async prepare(
    state: RunState,
    task: TaskNode,
    seedFromWorktree?: string,
  ): Promise<TaskWorkspace> {
    const path = this.taskPath(state.run_id, task.id, task.attempt);
    const reused = await this.validateExistingWorktree(path, state);
    if (!reused) {
      await mkdir(join(path, '..'), { recursive: true });
      await this.git.exec(
        ['worktree', 'add', '--detach', path, state.baseline_commit ?? 'HEAD'],
        state.repo_root,
        { run_id: state.run_id },
      );
    }
    if (!reused) {
      await this.seedNewWorktree(path, state, task, seedFromWorktree);
      await this.patchIntegrator?.freezeDeltaBase?.(path);
    }
    return {
      path,
      cleanup: async () => {
        await this.git.exec(['worktree', 'remove', '--force', path], state.repo_root, {
          run_id: state.run_id,
        });
      },
    };
  }

  async ensureIntegration(state: RunState): Promise<string> {
    const path = this.integrationPath(state.run_id);
    try {
      await access(path);
      return path;
    } catch {
      // Create the integration worktree below.
    }
    await mkdir(join(path, '..'), { recursive: true });
    await this.git.exec(
      ['worktree', 'add', '--detach', path, state.baseline_commit ?? 'HEAD'],
      state.repo_root,
      { run_id: state.run_id },
    );
    return path;
  }
}
