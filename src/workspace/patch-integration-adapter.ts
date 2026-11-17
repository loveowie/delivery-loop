import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CodeSnapshot,
  RunState,
  TaskNode,
} from '../domain/types.js';
import type {
  IntegrationResult,
  Integrator,
  TaskWorkspace,
  SnapshotProvider,
} from '../controller/delivery-controller.js';
import type { PatchArtifact } from './patch-integrator.js';

export interface IntegrationWorktreeProvider {
  ensureIntegration(state: RunState): Promise<string>;
  prepare(state: RunState, task: TaskNode, seedFromWorktree?: string): Promise<TaskWorkspace>;
  validateWorkspace?(path: string, state: RunState): Promise<void>;
}

export interface PatchExporter {
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
    approval: { run_id: string },
    options?: { requireFrozenBase?: boolean },
  ): Promise<PatchArtifact>;
  applyToIntegration(
    integrationWorktree: string,
    patchPath: string,
    approval: { run_id: string },
    options?: { threeWay?: boolean },
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface PatchIntegrationAdapterOptions {
  worktrees: IntegrationWorktreeProvider;
  patchIntegrator: PatchExporter;
  snapshots: SnapshotProvider;
  runDirectory: string;
}

export class PatchIntegrationAdapter implements Integrator {
  private readonly options: PatchIntegrationAdapterOptions;

  constructor(options: PatchIntegrationAdapterOptions) {
    this.options = options;
  }

  async integrate(
    state: RunState,
    task: TaskNode,
    workdir: string,
    taskSnapshot: CodeSnapshot,
  ): Promise<IntegrationResult> {
    const candidateKey = createHash('sha256').update(JSON.stringify([task.id, task.attempt, taskSnapshot.id, state.integration_snapshot_id])).digest('hex').slice(0, 20);
    const artifactDirectory = join(this.options.runDirectory, 'candidates', candidateKey);
    await mkdir(artifactDirectory, { recursive: true });
    const resultPath = join(artifactDirectory, 'result.json');
    try {
      const saved = JSON.parse(await readFile(resultPath, 'utf8')) as IntegrationResult;
      if (saved.workdir === undefined || saved.snapshot_id === undefined || saved.artifact === undefined) throw new Error('invalid saved candidate result');
      const actual = await this.options.snapshots.create(saved.workdir, state.baseline_commit ?? taskSnapshot.baseline_commit);
      const digest = createHash('sha256').update(await readFile(saved.artifact.path)).digest('hex');
      if (actual.id !== saved.snapshot_id || digest !== saved.artifact.sha256) throw new Error('saved integration candidate digest mismatch');
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Each unfinished try gets a fresh directory; a crash cannot cause a second apply to dirty content.
    await this.options.worktrees.validateWorkspace?.(workdir, state);
    const candidateTask: TaskNode = { ...task, id: `CANDIDATE-${candidateKey}-${randomUUID().slice(0, 8)}`, attempt: 0 };
    delete candidateTask.seed_worktree;
    const candidate = await this.options.worktrees.prepare(state, candidateTask, state.integration_worktree);
    const integrationWorktree = candidate.path;
    await this.options.worktrees.validateWorkspace?.(integrationWorktree, state);
    const patch = await this.options.patchIntegrator.exportDeltaPatch(
      workdir,
      artifactDirectory,
      taskSnapshot.untracked_files,
      { run_id: state.run_id },
      { requireFrozenBase: true },
    );
    const applied = await this.options.patchIntegrator.applyToIntegration(
      integrationWorktree,
      patch.path,
      { run_id: state.run_id },
      { threeWay: true },
    );
    if (!applied.ok) {
      return { ok: false, ...(applied.error === undefined ? {} : { error: applied.error }) };
    }
    const snapshot = await this.options.snapshots.create(
      integrationWorktree,
      state.baseline_commit ?? taskSnapshot.baseline_commit,
    );
    const artifact = await this.options.patchIntegrator.exportTaskPatch(
      integrationWorktree,
      state.baseline_commit ?? taskSnapshot.baseline_commit,
      artifactDirectory,
      snapshot.untracked_files,
      { run_id: state.run_id },
    );
    const result: IntegrationResult = {
      ok: true,
      workdir: integrationWorktree,
      snapshot_id: snapshot.id,
      artifact,
    };
    const temporary = `${resultPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(result), 'utf8');
    await rename(temporary, resultPath);
    return result;
  }
}
