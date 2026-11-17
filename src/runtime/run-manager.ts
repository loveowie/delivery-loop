import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { NodeRepositoryInspector, PreparedRunFactory } from '../controller/run-factory.js';
import type { RuntimeFactory } from './runtime-factory.js';
import type { DeliveryRunManagerPort, RuntimeHandle, StartRunInput } from './types.js';
import { RunRegistry } from './run-registry.js';
import { StateStore } from '../state/state-store.js';
import type { RunState } from '../domain/types.js';
import { GuardedGitAdapter, createNodeGitExecutor } from '../workspace/git-adapter.js';
import type {
  FinalizeAction,
  FinalizeExecutionContext,
  FinalizeRecord,
} from '../finalize/finalizer.js';
import { createCodeSnapshot } from '../workspace/repository-context.js';
import { durationExceeded, progressSignature } from './loop-guards.js';
import { acquireWorkerLock, hasActiveWorkerLock } from './worker-lock.js';
import type { WorkerLock } from './worker-lock.js';
import { recoverInterruptedRun } from '../controller/recovery.js';
import { recordDecision } from '../controller/decision-journal.js';
import { createHash } from 'node:crypto';

export interface DeliveryRunManagerOptions {
  pluginRoot: string;
  runtimeFactory: RuntimeFactory;
  preparedRunFactory?: PreparedRunFactory;
  registry?: RunRegistry;
  sleep?: (milliseconds: number) => Promise<void>;
}

function ownsRepositoryWriteSlot(status: string): boolean {
  return ['PLANNING', 'RUNNING', 'VERIFYING'].includes(status);
}

function runnableStatus(status: string): boolean {
  return ownsRepositoryWriteSlot(status);
}

async function acquireRepositoryLock(store: StateStore): Promise<() => Promise<void>> {
  const deliveryRoot = join(store.repoRoot, '.delivery');
  return await lockfile.lock(deliveryRoot, {
    realpath: false,
    lockfilePath: join(deliveryRoot, 'repository.lock'),
    stale: 30_000,
    update: 10_000,
    retries: { retries: 400, factor: 1, minTimeout: 10, maxTimeout: 25 },
  });
}

export async function queueRunForAdmission(
  store: StateStore,
  runId: string,
): Promise<RunState | undefined> {
  const release = await acquireRepositoryLock(store);
  try {
    const state = await store.readRun(runId);
    if (state === undefined || !runnableStatus(state.status) || state.pause_requested) {
      return state;
    }
    return await store.updateRun(runId, (draft) => ({ ...draft, status: 'QUEUED' }));
  } finally {
    await release();
  }
}

export async function drainRepositoryQueue(
  store: StateStore,
  launch: (state: RunState) => Promise<void>,
  ownerActive: (state: RunState) => Promise<boolean> = async (state) =>
    state.status !== 'QUEUED' && await hasActiveWorkerLock(store.repoRoot, state.run_id),
): Promise<RunState[]> {
  const release = await acquireRepositoryLock(store);
  const promoted: RunState[] = [];
  try {
    const runs = await store.listRuns();
    let activeCount = 0;
    for (const run of runs) {
      if (ownsRepositoryWriteSlot(run.status) || await ownerActive(run)) {
        activeCount += 1;
      }
    }
    const queued = runs
      .filter((run) => run.status === 'QUEUED' && !run.pause_requested)
      .sort(
        (left, right) =>
          left.created_at.localeCompare(right.created_at) || left.run_id.localeCompare(right.run_id),
      );
    for (const candidate of queued) {
      if (activeCount >= candidate.config.runtime.repository.max_active_write_runs) {
        break;
      }
      const admitted = await store.updateRun(candidate.run_id, (draft) => ({
        ...draft,
        status: 'PLANNING',
      }));
      promoted.push(admitted);
      activeCount += 1;
    }
  } finally {
    await release();
  }

  let launchFailed = false;
  for (const state of promoted) {
    try {
      await launch(state);
    } catch (error) {
      launchFailed = true;
      await store.updateRun(state.run_id, (current) => ({
        ...current,
        status: 'BLOCKED',
        last_error: error instanceof Error ? error.message : String(error),
      }));
      await store.appendEvent(state.run_id, {
        type: 'runtime_launch_error',
        message: error instanceof Error ? error.message : String(error),
      });
      await recordDecision(store, {
        run_id: state.run_id,
        phase: 'lifecycle',
        code: 'runtime_launch_error',
        title: '后台 Worker 启动失败，运行已阻塞',
        detail: error instanceof Error ? error.message : String(error),
        outcome: 'blocked',
      });
    }
  }
  if (launchFailed) {
    promoted.push(...await drainRepositoryQueue(store, launch));
  }
  return promoted;
}

function isUsableRefSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    && !value.includes('..')
    && !value.endsWith('.')
    && !value.endsWith('.lock');
}

function deliveryRefName(runId: string): string {
  return isUsableRefSegment(runId)
    ? runId
    : `R-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`;
}

function deliveryBranchName(runId: string): string {
  return `delivery/${deliveryRefName(runId)}`;
}

export class DeliveryRunManager implements DeliveryRunManagerPort {
  private readonly options: DeliveryRunManagerOptions;
  private readonly handles = new Map<string, RuntimeHandle>();
  private readonly loops = new Map<string, Promise<void>>();
  private readonly executionExits = new Map<string, Promise<void>>();
  private readonly workerLocks = new Map<string, WorkerLock>();
  private readonly registry: RunRegistry;

  constructor(options: DeliveryRunManagerOptions) {
    this.options = options;
    this.registry = options.registry ?? new RunRegistry();
  }

  async start(input: StartRunInput): Promise<RuntimeHandle> {
    const preparedFactory =
      this.options.preparedRunFactory ?? new PreparedRunFactory(new NodeRepositoryInspector());
    const state = await preparedFactory.create(input);
    const store = await StateStore.open(state.repo_root);
    const release = await acquireRepositoryLock(store);
    let queued: RunState;
    try {
      queued = await store.updateRun(state.run_id, (draft) => ({
        ...draft,
        status: 'QUEUED',
      }));
    } finally {
      await release();
    }
    await this.registry.register(state.run_id, state.repo_root);
    let runtime;
    try {
      runtime = await this.options.runtimeFactory.create(state.repo_root, state.run_id);
    } catch (error) {
      await store.updateRun(state.run_id, (draft) => ({
        ...draft,
        status: 'BLOCKED',
        last_error: error instanceof Error ? error.message : String(error),
      }));
      await recordDecision(store, {
        run_id: state.run_id,
        phase: 'lifecycle',
        code: 'runtime_init_failed',
        title: '运行时初始化失败，运行已阻塞',
        detail: error instanceof Error ? error.message : String(error),
        outcome: 'blocked',
      });
      await this.drain(store);
      throw error;
    }
    const handle: RuntimeHandle = {
      state: queued,
      store: runtime.store,
      repoRoot: state.repo_root,
      controller: runtime.controller,
      evidenceLedger: runtime.evidenceLedger,
    };
    this.handles.set(state.run_id, handle);
    await this.drain(handle.store);
    handle.state = (await handle.store.readRun(state.run_id)) ?? handle.state;
    return handle;
  }

  async read(runId: string, repoRoot?: string) {
    const root = repoRoot ?? (await this.registry.lookup(runId));
    if (root === undefined) {
      throw new Error(`run not found in registry: ${runId}`);
    }
    const store = await StateStore.open(root);
    const state = await store.readRun(runId);
    if (state === undefined) {
      throw new Error(`run not found: ${runId}`);
    }
    return { state, store, repoRoot: root };
  }

  async get(runId: string, repoRoot?: string): Promise<RuntimeHandle> {
    const existing = this.handles.get(runId);
    if (existing !== undefined) {
      existing.state = (await existing.store.readRun(runId)) ?? existing.state;
      return existing;
    }
    const root = repoRoot ?? (await this.registry.lookup(runId));
    if (root === undefined) {
      throw new Error(`run not found in registry: ${runId}`);
    }
    const runtime = await this.options.runtimeFactory.create(root, runId);
    const state = await runtime.store.readRun(runId);
    if (state === undefined) {
      throw new Error(`run not found: ${runId}`);
    }
    const handle: RuntimeHandle = {
      state,
      store: runtime.store,
      repoRoot: root,
      controller: runtime.controller,
      evidenceLedger: runtime.evidenceLedger,
    };
    this.handles.set(runId, handle);
    return handle;
  }

  async wake(handle: RuntimeHandle): Promise<void> {
    handle.state = (await handle.store.readRun(handle.state.run_id)) ?? handle.state;
    if (await this.ownerActive(handle.state)) {
      return;
    }
    if (['PLANNING', 'RUNNING', 'VERIFYING', 'WAITING_HUMAN'].includes(handle.state.status) && !handle.state.pause_requested) {
      await this.recoverStaleRuns(handle.store);
      handle.state = (await handle.store.readRun(handle.state.run_id)) ?? handle.state;
    }
    if (runnableStatus(handle.state.status) && !handle.state.pause_requested) {
      handle.state = (await queueRunForAdmission(handle.store, handle.state.run_id)) ?? handle.state;
    }
    await this.drain(handle.store);
  }

  private async releaseWorkerLock(runId: string): Promise<void> {
    const lock = this.workerLocks.get(runId);
    if (lock === undefined) return;
    this.workerLocks.delete(runId);
    await lock.release().catch(() => undefined);
  }

  /**
   * Reset in-flight tasks and queue runs whose owning Host is gone. This is the
   * difference between "durable state exists" and "a restarted Host can
   * actually continue the run": without it a crash leaves tasks RUNNING
   * forever and the run is eventually blocked by the no-progress guard.
   */
  private async recoverStaleRuns(store: StateStore): Promise<void> {
    let runs: RunState[];
    try {
      runs = await store.listRuns();
    } catch {
      return;
    }
    for (const run of runs) {
      if (!['PLANNING', 'RUNNING', 'VERIFYING', 'WAITING_HUMAN'].includes(run.status)) continue;
      if (run.pause_requested) continue;
      // A freshly promoted run may not have acquired its worker lock yet; do
      // not steal it inside that admission window.
      if (
        run.status === 'PLANNING' &&
        Number.isFinite(Date.parse(run.updated_at)) &&
        Date.now() - Date.parse(run.updated_at) < 30_000
      ) {
        continue;
      }
      try {
        if (await this.ownerActive(run)) continue;
        await recoverInterruptedRun(store, run.run_id);
        if (run.status === 'WAITING_HUMAN') {
          // A crash while a sibling task was still running must not leave that
          // task RUNNING forever. Keep the run waiting for its decisions.
          await store.appendEvent(run.run_id, {
            type: 'run_recovered',
            previous_status: run.status,
          });
          await recordDecision(store, {
            run_id: run.run_id,
            phase: 'lifecycle',
            code: 'run_recovered',
            title: '恢复等待人工决策的运行',
            detail: '进行中的任务已重新排队，待决策完成后继续。',
            outcome: 'info',
          });
          continue;
        }
        await store.updateRun(run.run_id, (draft) => ({
          ...draft,
          status: 'QUEUED',
        }));
        await store.appendEvent(run.run_id, {
          type: 'run_recovered',
          previous_status: run.status,
        });
        await recordDecision(store, {
          run_id: run.run_id,
          phase: 'lifecycle',
          code: 'run_recovered',
          title: '恢复中断的交付运行',
          detail: `原状态 ${run.status}，进行中的任务已重新排队。`,
          outcome: 'info',
        });
      } catch (error) {
        await store.appendEvent(run.run_id, {
          type: 'run_recovery_error',
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
    }
  }

  async ensureActive(runId: string, repoRoot?: string): Promise<void> {
    try {
      const root = repoRoot ?? (await this.registry.lookup(runId));
      if (root === undefined) return;
      const store = await StateStore.open(root);
      const state = await store.readRun(runId);
      if (state === undefined) return;
      if (!['QUEUED', 'PLANNING', 'RUNNING', 'VERIFYING'].includes(state.status)) return;
      const handle = await this.get(runId, root);
      await this.wake(handle);
    } catch (error) {
      const root = repoRoot ?? (await this.registry.lookup(runId).catch(() => undefined));
      if (root !== undefined) {
        const store = await StateStore.open(root).catch(() => undefined);
        await store?.appendEvent(runId, {
          type: 'wake_error',
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
    }
  }

  private async launchPromoted(state: RunState, store: StateStore): Promise<void> {
    if (this.loops.has(state.run_id)) return;
    let handle = this.handles.get(state.run_id);
    if (handle !== undefined) {
      handle.state = state;
    }
    if (handle === undefined) {
      const runtime = await this.options.runtimeFactory.create(store.repoRoot, state.run_id);
      handle = {
        state,
        store: runtime.store,
        repoRoot: store.repoRoot,
        controller: runtime.controller,
        evidenceLedger: runtime.evidenceLedger,
      };
      this.handles.set(state.run_id, handle);
    }
    if (!this.workerLocks.has(state.run_id)) {
      const lock = await acquireWorkerLock(store.repoRoot, state.run_id);
      if (!lock.acquired) {
        // Another controller owns this run. Do not run it twice; leave it
        // queued for a later admission once that owner releases the lock.
        await store.updateRun(state.run_id, (draft) => ({ ...draft, status: 'QUEUED' }));
        return;
      }
      this.workerLocks.set(state.run_id, lock);
    }
    try {
      handle.state = await handle.controller.start(state.run_id);
      this.ensureLoop(handle);
    } catch (error) {
      await this.releaseWorkerLock(state.run_id);
      throw error;
    }
  }

  private async drain(store: StateStore): Promise<void> {
    await this.recoverStaleRuns(store);
    await drainRepositoryQueue(
      store,
      async (state) => await this.launchPromoted(state, store),
      async (state) => await this.ownerActive(state),
    );
  }

  private async ownerActive(state: RunState): Promise<boolean> {
    if (this.loops.has(state.run_id)) {
      return true;
    }
    // A live worker lock means some controller still owns this run, even when
    // the run is currently WAITING_HUMAN (its tick may still be finishing
    // sibling tasks). Never "recover" a run that another process is executing.
    return await hasActiveWorkerLock(state.repo_root, state.run_id);
  }

  private ensureLoop(handle: RuntimeHandle): void {
    if (this.loops.has(handle.state.run_id)) {
      return;
    }
    const runId = handle.state.run_id;
    const loop = this.runLoop(handle);
    this.loops.set(runId, loop);
    const executionExit = loop.finally(async () => {
      this.loops.delete(runId);
      await this.releaseWorkerLock(runId);
      handle.state = (await queueRunForAdmission(handle.store, runId)) ?? handle.state;
      await this.drain(handle.store).catch(async (error) => {
        await handle.store.appendEvent(runId, {
          type: 'queue_drain_error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
    this.executionExits.set(runId, executionExit);
  }

  async waitForExecutionExit(runId: string): Promise<void> {
    await this.executionExits.get(runId);
  }

  private async runLoop(handle: RuntimeHandle): Promise<void> {
    const sleep = this.options.sleep ?? (async (milliseconds: number) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
    let previousProgress = progressSignature(handle.state);
    let stagnantCycles = 0;
    while (true) {
      const state = await handle.store.readRun(handle.state.run_id);
      if (state === undefined) {
        return;
      }
      handle.state = state;
      if (state.pause_requested) {
        handle.state = await handle.controller.tick(state.run_id);
        return;
      }
      if (!runnableStatus(state.status)) {
        return;
      }
      if (durationExceeded(state)) {
        handle.state = await handle.store.updateRun(state.run_id, (draft) => ({
          ...draft,
          status: 'BLOCKED',
          last_error: 'maximum run duration exceeded',
        }));
        await recordDecision(handle.store, {
          run_id: state.run_id,
          phase: 'lifecycle',
          code: 'duration_exceeded',
          title: '超过最大运行时长，运行已阻塞',
          detail: `上限 ${state.config.runtime.max_duration_hours} 小时。`,
          outcome: 'blocked',
        });
        return;
      }
      try {
        const next = await handle.controller.tick(state.run_id);
        handle.state = next;
        if (!runnableStatus(next.status)) {
          return;
        }
        const currentProgress = progressSignature(next);
        stagnantCycles = currentProgress === previousProgress ? stagnantCycles + 1 : 0;
        previousProgress = currentProgress;
        if (stagnantCycles >= next.config.runtime.no_progress_cycles) {
          handle.state = await handle.store.updateRun(next.run_id, (draft) => ({
            ...draft,
            status: 'BLOCKED',
            last_error: 'no progress detected',
          }));
          await recordDecision(handle.store, {
            run_id: next.run_id,
            phase: 'lifecycle',
            code: 'no_progress',
            title: '连续多个调度周期没有进展，运行已阻塞',
            detail: `${stagnantCycles} 个周期未观察到状态变化。`,
            outcome: 'blocked',
          });
          return;
        }
      } catch (error) {
        const failed = await handle.store.updateRun(state.run_id, (draft) => ({
          ...draft,
          status: 'BLOCKED',
          last_error: error instanceof Error ? error.message : String(error),
        }));
        await recordDecision(handle.store, {
          run_id: state.run_id,
          phase: 'lifecycle',
          code: 'runtime_error',
          title: '调度循环异常，运行已阻塞',
          detail: error instanceof Error ? error.message : String(error),
          outcome: 'fail',
        });
        handle.state = failed;
        return;
      }
      await sleep(250);
    }
  }

  async executeFinalize(
    action: FinalizeAction,
    handle: RuntimeHandle,
    context: FinalizeExecutionContext,
  ): Promise<FinalizeRecord> {
    if (action === 'merge') {
      throw new Error('merge finalization requires a project-specific finalizer');
    }
    const nodeGit = createNodeGitExecutor();
    const git = new GuardedGitAdapter(nodeGit);
    const cwd = handle.state.integration_worktree;
    if (cwd === undefined) {
      throw new Error(`accepted integration worktree is unavailable for run: ${handle.state.run_id}`);
    }
    const approval = { run_id: handle.state.run_id };
    const snapshot = await createCodeSnapshot(cwd, {
      async exec(args, workdir) {
        return (await git.exec(args, workdir)).stdout;
      },
    });
    if (
      handle.state.integration_snapshot_id === undefined ||
      snapshot.id !== handle.state.integration_snapshot_id
    ) {
      throw new Error(
        `integration snapshot changed before finalization: expected ${handle.state.integration_snapshot_id ?? 'none'}, got ${snapshot.id}`,
      );
    }
    const branch = deliveryBranchName(handle.state.run_id);
    const branchRef = `refs/heads/${branch}`;
    const remoteRef = `refs/heads/${branch}`;
    const deliveryRef = `refs/delivery/${deliveryRefName(handle.state.run_id)}`;
    const commitMessage = `delivery: complete ${handle.state.run_id}`;
    const readHead = async (): Promise<string> =>
      (await nodeGit(['rev-parse', 'HEAD'], cwd)).stdout.trim();
    const readBranchRef = async (): Promise<string | null> => {
      const result = await nodeGit(['rev-parse', '--verify', branchRef], cwd);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    };
    const readCurrentBranch = async (): Promise<string | null> => {
      const result = await nodeGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    };
    const readRemoteRef = async (): Promise<string | null> => {
      const result = await nodeGit(['ls-remote', '--refs', 'origin', remoteRef], cwd);
      if (result.exitCode !== 0) {
        throw new Error(`cannot inspect remote finalization ref: ${result.stderr || result.stdout}`);
      }
      return result.stdout.trim().split(/\s+/)[0] || null;
    };
    const ownedCommit = async (commit: string): Promise<boolean> => {
      const result = await nodeGit(['log', '-1', '--format=%s', commit], cwd);
      return result.exitCode === 0 && result.stdout.trim() === commitMessage;
    };

    if (context.journal.metadata === undefined) {
      const metadata: FinalizeRecord = {
        starting_head: await readHead(),
      };
      if (action === 'branch' || action === 'push') {
        const existingBranch = await readBranchRef();
        if (existingBranch !== null) {
          throw new Error(`finalization branch already exists: ${branch}`);
        }
        metadata.target_branch = branch;
        metadata.target_ref_before = null;
      }
      if (action === 'push') {
        const existingRemote = await readRemoteRef();
        if (existingRemote !== null) {
          throw new Error(`remote finalization ref already exists: ${remoteRef}`);
        }
        metadata.remote_ref_before = null;
      }
      await context.recordIntentMetadata(metadata);
    }

    const startingHead = context.journal.metadata?.starting_head;
    if (typeof startingHead !== 'string') {
      throw new Error('finalization journal is missing starting HEAD metadata');
    }

    if (action === 'branch' || action === 'push') {
      const existingBranch = await readBranchRef();
      if (existingBranch === null) {
        await git.exec(['-c', 'core.hooksPath=/dev/null', 'switch', '-c', branch], cwd, approval);
      } else {
        const branchIsRecoverable =
          existingBranch === startingHead || await ownedCommit(existingBranch);
        if (!context.reconcile || !branchIsRecoverable) {
          throw new Error(`conflicting finalization branch exists: ${branch}`);
        }
        if ((await readCurrentBranch()) !== branch) {
          await git.exec(['-c', 'core.hooksPath=/dev/null', 'switch', branch], cwd, approval);
        }
      }
    }

    let head = await readHead();
    const alreadyCommitted = head !== startingHead && await ownedCommit(head);
    if (!alreadyCommitted) {
      if (head !== startingHead) {
        throw new Error(`HEAD changed since finalization intent: expected ${startingHead}, got ${head}`);
      }
      await git.exec(['add', '-A'], cwd, approval);
      const status = await git.exec(['status', '--porcelain'], cwd);
      if (status.stdout.trim().length > 0) {
        // Never execute hooks or signing programs from worker-controlled
        // content on the host. A delivery commit must be a pure data operation.
        await git.exec([
          '-c', 'core.hooksPath=/dev/null',
          '-c', 'core.fsmonitor=false',
          '-c', 'commit.gpgsign=false',
          'commit', '--no-verify', '-m', commitMessage,
        ], cwd, approval);
      }
      head = await readHead();
    }
    if (action === 'commit') {
      // A detached commit is unreachable and can be pruned once the
      // integration worktree is removed. Park it on a durable ref.
      await git.exec(['update-ref', deliveryRef, head], cwd, approval);
    }

    if (action === 'push') {
      const remoteBefore = context.journal.metadata?.remote_ref_before;
      if (remoteBefore !== null && typeof remoteBefore !== 'string') {
        throw new Error('push finalization journal is missing the original remote ref');
      }
      const remoteNow = await readRemoteRef();
      if (remoteNow !== head) {
        if (remoteNow !== remoteBefore) {
          throw new Error(
            `remote finalization ref changed during recovery: expected ${remoteBefore ?? 'missing'}, got ${remoteNow ?? 'missing'}`,
          );
        }
        await git.exec(
          [
            '-c', 'core.hooksPath=/dev/null',
            'push',
            `--force-with-lease=${remoteRef}:${remoteBefore ?? ''}`,
            'origin',
            `HEAD:${remoteRef}`,
          ],
          cwd,
          approval,
        );
      }
    }
    return action === 'commit'
      ? { head, branch: null, ref: deliveryRef }
      : { head, branch, ref: branchRef };
  }
}
