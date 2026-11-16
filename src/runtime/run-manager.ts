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
import { hasActiveWorkerLock } from './worker-lock.js';

export interface DeliveryRunManagerOptions {
  pluginRoot: string;
  runtimeFactory: RuntimeFactory;
  preparedRunFactory?: PreparedRunFactory;
  registry?: RunRegistry;
  sleep?: (milliseconds: number) => Promise<void>;
  workerLauncher?: (repoRoot: string, runId: string, pluginRoot: string) => Promise<void>;
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
    }
  }
  if (launchFailed) {
    promoted.push(...await drainRepositoryQueue(store, launch));
  }
  return promoted;
}

export class DeliveryRunManager implements DeliveryRunManagerPort {
  private readonly options: DeliveryRunManagerOptions;
  private readonly handles = new Map<string, RuntimeHandle>();
  private readonly loops = new Map<string, Promise<void>>();
  private readonly executionExits = new Map<string, Promise<void>>();
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
    if (runnableStatus(handle.state.status) && !handle.state.pause_requested) {
      handle.state = (await queueRunForAdmission(handle.store, handle.state.run_id)) ?? handle.state;
    }
    await this.drain(handle.store);
  }

  private async launchPromoted(state: RunState, store: StateStore): Promise<void> {
    let handle = this.handles.get(state.run_id);
    if (handle !== undefined) {
      handle.state = state;
    }
    if (
      this.options.workerLauncher !== undefined &&
      state.config.runtime.daemon_mode === 'detached'
    ) {
      await this.options.workerLauncher(store.repoRoot, state.run_id, this.options.pluginRoot);
      return;
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
    handle.state = await handle.controller.start(state.run_id);
    this.ensureLoop(handle);
  }

  private async drain(store: StateStore): Promise<void> {
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
    return state.status !== 'QUEUED' && await hasActiveWorkerLock(state.repo_root, state.run_id);
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
          return;
        }
      } catch (error) {
        const failed = await handle.store.updateRun(state.run_id, (draft) => ({
          ...draft,
          status: 'BLOCKED',
          last_error: error instanceof Error ? error.message : String(error),
        }));
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
    const branch = `delivery/${handle.state.run_id}`;
    const branchRef = `refs/heads/${branch}`;
    const remoteRef = `refs/heads/${branch}`;
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
        await git.exec(['switch', '-c', branch], cwd, approval);
      } else {
        const branchIsRecoverable =
          existingBranch === startingHead || await ownedCommit(existingBranch);
        if (!context.reconcile || !branchIsRecoverable) {
          throw new Error(`conflicting finalization branch exists: ${branch}`);
        }
        if ((await readCurrentBranch()) !== branch) {
          await git.exec(['switch', branch], cwd, approval);
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
        await git.exec(['commit', '-m', commitMessage], cwd, approval);
      }
      head = await readHead();
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
    return { head, branch: action === 'commit' ? null : branch };
  }
}
