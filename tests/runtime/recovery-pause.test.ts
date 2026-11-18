import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryController } from '../../src/controller/delivery-controller.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type {
  AcceptanceCondition,
  AgentRequest,
  AgentResult,
  CodeSnapshot,
  DeliveryConfig,
  EvidenceRecord,
  RunState,
  TaskNode,
} from '../../src/domain/types.js';
import { DeliveryRunManager } from '../../src/runtime/run-manager.js';
import { RunRegistry } from '../../src/runtime/run-registry.js';
import { StateStore } from '../../src/state/state-store.js';
import type { VerificationRequest } from '../../src/verification/command-runner.js';

const SNAPSHOT: CodeSnapshot = {
  id: 'SNAP-1',
  created_at: '2026-11-17T00:00:00.000Z',
  baseline_commit: 'abc123',
  worktree_digest: 'digest',
  untracked_files: [],
};

function task(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    type: 'implementation',
    title: id,
    status: 'READY',
    priority: 'normal',
    risk: 'low',
    origin: 'initial_plan',
    depends_on: [],
    requirement_ids: ['REQ-1'],
    acceptance_ids: ['AC-1'],
    scope_paths: ['src'],
    required_outputs: [],
    worker_role: 'implementer',
    capability_profile: 'portable',
    attempt: 0,
    max_attempts: 3,
    verification_commands: ['npm test'],
    review_policy: 'none',
    ...overrides,
  };
}

function commandAcceptance(): AcceptanceCondition {
  return {
    id: 'AC-1',
    requirement_id: 'REQ-1',
    description: 'tests pass',
    verification: { type: 'command', command: 'npm test', expected_exit_code: 0 },
    mandatory: true,
    risk: 'low',
  };
}

function runState(
  repo: string,
  runId: string,
  status: RunState['status'],
  tasks: TaskNode[],
  createdAt: string,
): RunState {
  const config = structuredClone(DEFAULT_CONFIG as DeliveryConfig);
  config.review.final_review = false;
  return {
    state_schema_version: 1,
    run_id: runId,
    status,
    repo_root: repo,
    created_at: createdAt,
    updated_at: createdAt,
    config,
    graph: {
      run_id: runId,
      requirements: [{ id: 'REQ-1', description: 'works', status: 'SATISFIED' }],
      acceptance: [commandAcceptance()],
      tasks,
    },
    current_task_ids: tasks.filter((candidate) => candidate.status === 'RUNNING').map((candidate) => candidate.id),
    pause_requested: false,
    pending_decision_ids: [],
  };
}

function completed(taskId: string): AgentResult {
  return {
    task_id: taskId,
    status: 'completed',
    summary: 'done',
    files_changed: [],
    commands_run: [],
    findings: [],
    remaining_risks: [],
    suggested_tasks: [],
    blockers: [],
  };
}

function verificationEvidence(request: VerificationRequest): EvidenceRecord {
  return {
    id: `E-${request.command}`,
    run_id: request.run_id,
    task_id: request.task_id,
    acceptance_ids: request.acceptance_ids,
    code_snapshot_id: request.code_snapshot_id,
    command: request.command,
    cwd: request.cwd,
    started_at: '2026-11-17T00:00:00.000Z',
    finished_at: '2026-11-17T00:00:01.000Z',
    exit_code: 0,
    stdout_path: '',
    stderr_path: '',
    result: 'passed',
  };
}

function buildController(
  repo: string,
  store: StateStore,
  options: { snapshotCreate?: (call: number) => Promise<CodeSnapshot> } = {},
): DeliveryController {
  const workdir = join(repo, 'worktree');
  let snapshotCalls = 0;
  return new DeliveryController({
    repoRoot: repo,
    store,
    workers: {
      async run(request: AgentRequest) {
        return completed(request.task_id);
      },
    },
    skills: {
      async resolve() {
        return [];
      },
      async verifyAll() {},
    },
    worktrees: {
      async prepare() {
        return { path: workdir, cleanup: async () => {} };
      },
    },
    snapshots: {
      async create() {
        snapshotCalls += 1;
        return options.snapshotCreate === undefined
          ? SNAPSHOT
          : await options.snapshotCreate(snapshotCalls);
      },
      async changedFiles() {
        return [];
      },
    },
    verifier: {
      async run(request) {
        return verificationEvidence(request);
      },
    },
    integrator: {
      async integrate() {
        return { ok: true, workdir, snapshot_id: SNAPSHOT.id };
      },
    },
  });
}

async function createManager(
  runtimeFor: (repo: string, runId: string) => Promise<{
    store: StateStore;
    controller: DeliveryController;
  }>,
): Promise<DeliveryRunManager> {
  const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'delivery-loop-registry-')));
  return new DeliveryRunManager({
    pluginRoot: process.cwd(),
    registry,
    runtimeFactory: {
      async create(repo: string, runId: string) {
        const runtime = await runtimeFor(repo, runId);
        return { store: runtime.store, controller: runtime.controller, evidenceLedger: undefined };
      },
    } as never,
    sleep: async () => {},
  });
}

test('a tick failure leaves the run BLOCKED with the task RUNNING and resume can finish it', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-recovery-pause-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'run-1', 'RUNNING', [task('TASK-1')], new Date().toISOString()));

  const controller = buildController(repo, store, {
    snapshotCreate: async (call) => {
      if (call === 1) throw new Error('snapshot service unavailable');
      return SNAPSHOT;
    },
  });
  const manager = await createManager(async () => ({ store, controller }));
  const handle = await manager.get('run-1', repo);

  await manager.wake(handle);
  await manager.waitForExecutionExit('run-1');

  const blocked = (await store.readRun('run-1'))!;
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.graph.tasks[0]?.status, 'RUNNING');
  assert.match(blocked.last_error ?? '', /snapshot service unavailable/);

  const resumed = await controller.resume('run-1');
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(resumed.graph.tasks[0]?.status, 'READY');

  await manager.wake(handle);
  await manager.waitForExecutionExit('run-1');

  const completedRun = (await store.readRun('run-1'))!;
  assert.equal(completedRun.status, 'COMPLETED');
  assert.equal(completedRun.graph.tasks[0]?.status, 'DONE');
});

test('wake consumes the retry budget of an interrupted task and blocks the run when exhausted', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-recovery-pause-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, 'run-1', 'RUNNING', [
    task('TASK-1', { status: 'RUNNING', attempt: 2, max_attempts: 3 }),
  ], new Date().toISOString()));

  let started = false;
  const manager = await createManager(async () => ({
    store,
    controller: {
      async start() {
        started = true;
        return (await store.readRun('run-1'))!;
      },
      async tick() {
        return (await store.readRun('run-1'))!;
      },
      async cancel() {
        return (await store.readRun('run-1'))!;
      },
    } as never,
  }));
  const handle = await manager.get('run-1', repo);

  await manager.wake(handle);

  const blocked = (await store.readRun('run-1'))!;
  assert.equal(started, false);
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.graph.tasks[0]?.status, 'BLOCKED');
  assert.equal(blocked.graph.tasks[0]?.attempt, 3);
  const events = await readFile(join(store.getRunDirectory('run-1'), 'events.jsonl'), 'utf8');
  assert.match(events, /recovery_attempts_exhausted/);
});

test('an orphaned pause request becomes PAUSED, frees the write slot and resumes later', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-recovery-pause-'));
  const store = await StateStore.open(repo);
  const now = Date.now();
  const orphaned = runState(
    repo,
    'paused-run',
    'RUNNING',
    [task('TASK-1', { status: 'RUNNING' })],
    new Date(now).toISOString(),
  );
  orphaned.pause_requested = true;
  await store.createRun(orphaned);
  await store.createRun(runState(
    repo,
    'queued-run',
    'QUEUED',
    [],
    new Date(now + 1_000).toISOString(),
  ));

  const controller = buildController(repo, store);
  const queuedStarts: string[] = [];
  const manager = await createManager(async (_repo, runId) => {
    if (runId === 'paused-run') {
      return { store, controller };
    }
    return {
      store,
      controller: {
        async start() {
          queuedStarts.push(runId);
          return await store.updateRun(runId, (draft) => ({ ...draft, status: 'RUNNING' }));
        },
        async tick() {
          return await store.updateRun(runId, (draft) => ({ ...draft, status: 'COMPLETED' }));
        },
        async cancel() {
          return (await store.readRun(runId))!;
        },
      } as never,
    };
  });

  const handle = await manager.get('paused-run', repo);
  await manager.wake(handle);
  await manager.waitForExecutionExit('queued-run');

  const paused = (await store.readRun('paused-run'))!;
  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.pause_requested, true);
  assert.equal(paused.graph.tasks[0]?.status, 'READY');
  // Pausing is not a failed attempt: the retry budget is preserved.
  assert.equal(paused.graph.tasks[0]?.attempt, 0);
  assert.equal((await store.readRun('queued-run'))?.status, 'COMPLETED');
  assert.deepEqual(queuedStarts, ['queued-run']);
  const events = await readFile(join(store.getRunDirectory('paused-run'), 'events.jsonl'), 'utf8');
  assert.match(events, /run_paused_recovered/);

  // A further wake must not relaunch a run that is intentionally paused.
  await manager.wake(handle);
  assert.equal((await store.readRun('paused-run'))?.status, 'PAUSED');
  assert.deepEqual(queuedStarts, ['queued-run']);

  const resumed = await controller.resume('paused-run');
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(resumed.pause_requested, false);

  await manager.wake(handle);
  await manager.waitForExecutionExit('paused-run');

  const completedRun = (await store.readRun('paused-run'))!;
  assert.equal(completedRun.status, 'COMPLETED');
  assert.equal(completedRun.graph.tasks[0]?.status, 'DONE');
});
