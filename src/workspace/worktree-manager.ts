import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RunState, TaskNode } from '../domain/types.js';
import type { TaskWorkspace, WorktreeProvider } from '../controller/delivery-controller.js';
import { GuardedGitAdapter, createNodeGitExecutor } from './git-adapter.js';
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
    options?: { threeWay?: boolean },
  ): Promise<{ ok: boolean; error?: string }>;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`invalid worktree segment: ${value}`);
  }
  return value;
}

/**
 * Re-establish that a path the controller is about to read, hash, or apply a
 * patch in is the managed worktree it claims to be.
 *
 * A managed worktree lives inside the target repository, and its `.git` is a
 * plain file pointing at the real gitdir. If something deletes or rewrites that
 * file, every `git` command run with the worktree as cwd silently falls back to
 * the developer's real checkout. The check is deliberately repeated at every
 * controller-side snapshot/patch operation, not only when the worktree is
 * created, because workers can write to their worktree between those steps.
 */
export async function assertManagedWorktree(
  workdir: string,
  repoRoot: string,
  expectedHead: string | undefined,
  executor?: GitExecutor,
): Promise<void> {
  const git = executor ?? new GuardedGitAdapter(createNodeGitExecutor());
  const resolvedRepo = resolve(repoRoot);
  const resolved = resolve(workdir);
  let details;
  try {
    details = await lstat(resolved);
  } catch {
    throw new Error(`managed worktree is missing: ${resolved}`);
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`managed worktree must be a real directory: ${resolved}`);
  }
  let gitEntry;
  try {
    gitEntry = await lstat(join(resolved, '.git'));
  } catch {
    throw new Error(`managed worktree is missing its .git entry: ${resolved}`);
  }
  if (!gitEntry.isFile() && !gitEntry.isDirectory()) {
    throw new Error(`managed worktree has an invalid .git entry: ${resolved}`);
  }

  const expectedCommit = expectedHead === undefined || expectedHead === 'HEAD'
    ? undefined
    : expectedHead;
  const [rootResult, worktreeCommonResult, repoCommonResult, headResult, expectedResult] =
    await Promise.all([
      git.exec(['rev-parse', '--show-toplevel'], resolved),
      git.exec(['rev-parse', '--git-common-dir'], resolved),
      git.exec(['rev-parse', '--git-common-dir'], resolvedRepo),
      git.exec(['rev-parse', 'HEAD'], resolved),
      expectedCommit === undefined
        ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
        : git.exec(['rev-parse', expectedCommit], resolvedRepo),
    ]);
  const expectedRoot = await realpath(resolved);
  const root = await realpath(resolve(rootResult.stdout.trim()));
  const absoluteGitPath = (value: string, rootPath: string) =>
    isAbsolute(value) ? resolve(value) : resolve(rootPath, value);
  const worktreeCommon = await realpath(
    absoluteGitPath(worktreeCommonResult.stdout.trim(), root),
  );
  const repoCommon = await realpath(
    absoluteGitPath(repoCommonResult.stdout.trim(), resolvedRepo),
  );
  if (root !== expectedRoot) {
    throw new Error(`managed worktree resolves to an unexpected git root: ${resolved}`);
  }
  if (worktreeCommon !== repoCommon) {
    throw new Error(`managed worktree belongs to a different repository: ${resolved}`);
  }
  if (expectedCommit !== undefined && headResult.stdout.trim() !== expectedResult.stdout.trim()) {
    throw new Error(`managed worktree HEAD changed unexpectedly: ${resolved}`);
  }
  const relativeToRepo = relative(await realpath(resolvedRepo), expectedRoot);
  const segments = relativeToRepo.split(sep);
  if (
    isAbsolute(relativeToRepo) ||
    relativeToRepo.startsWith('..') ||
    segments[0] !== '.delivery' ||
    segments[1] !== 'runs'
  ) {
    throw new Error(`managed worktree is not inside the run directory: ${resolved}`);
  }
}

function isManagedPath(path: string, repoRoot: string): boolean {
  const relativeToRepo = relative(resolve(repoRoot), resolve(path));
  return !isAbsolute(relativeToRepo)
    && !relativeToRepo.startsWith('..')
    && relativeToRepo.split(sep)[0] === '.delivery'
    && relativeToRepo.split(sep)[1] === 'runs';
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
    try {
      await assertManagedWorktree(path, state.repo_root, state.baseline_commit ?? 'HEAD', this.git);
    } catch (error) {
      throw new Error(
        `existing task worktree is invalid: ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  }

  /** Fail closed before any controller-side read, hash or patch operation. */
  async validateWorkspace(path: string, state: RunState): Promise<void> {
    await assertManagedWorktree(path, state.repo_root, state.baseline_commit ?? 'HEAD', this.git);
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
    if (seedFromWorktree !== undefined && isManagedPath(seedFromWorktree, state.repo_root)) {
      await this.validateWorkspace(seedFromWorktree, state);
    }
    const reused = await this.validateExistingWorktree(path, state);
    if (!reused) {
      await mkdir(join(path, '..'), { recursive: true });
      await this.git.exec(
        ['worktree', 'add', '--detach', path, state.baseline_commit ?? 'HEAD'],
        state.repo_root,
        { run_id: state.run_id },
      );
      try {
        await this.seedNewWorktree(path, state, task, seedFromWorktree);
        await this.patchIntegrator?.freezeDeltaBase?.(path);
      } catch (error) {
        // Never leave a partially seeded worktree registered: a later attempt
        // would reuse it without the frozen seed index and fail at export.
        await this.git
          .exec(['worktree', 'remove', '--force', path], state.repo_root, { run_id: state.run_id })
          .catch(() => undefined);
        throw error;
      }
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
      await assertManagedWorktree(path, state.repo_root, state.baseline_commit ?? 'HEAD', this.git);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `existing integration worktree is invalid: ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // ENOENT: create the integration worktree below.
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
