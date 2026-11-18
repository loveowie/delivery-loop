import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryController } from '../../src/controller/delivery-controller.js';
import { recoverInterruptedRun } from '../../src/controller/recovery.js';
import { StateStore } from '../../src/state/state-store.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { assertRunTransition } from '../../src/scheduler/state-machine.js';
import type {
  AcceptanceCondition,
  AgentRequest,
  AgentResult,
  CodeSnapshot,
  DeliveryConfig,
  EvidenceRecord,
  RunState,
  TaskGraph,
  TaskNode,
} from '../../src/domain/types.js';
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
  graph: TaskGraph,
  status: RunState['status'] = 'RUNNING',
): RunState {
  const config = structuredClone(DEFAULT_CONFIG as DeliveryConfig);
  config.review.final_review = false;
  return {
    state_schema_version: 1,
    run_id: 'run-1',
    status,
    repo_root: repo,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    config,
    graph,
    current_task_ids: [],
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

function verificationEvidence(request: VerificationRequest, passed = true): EvidenceRecord {
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
    exit_code: passed ? 0 : 1,
    stdout_path: '',
    stderr_path: '',
    result: passed ? 'passed' : 'failed',
  };
}

interface SetupOptions {
  status?: RunState['status'];
  taskOverrides?: Partial<TaskNode>;
  snapshotCreate?: (call: number) => Promise<CodeSnapshot>;
}

async function setup(options: SetupOptions = {}): Promise<{
  controller: DeliveryController;
  store: StateStore;
  repo: string;
}> {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-recovery-pause-'));
  const workdir = join(repo, 'worktree');
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'works', status: 'SATISFIED' }],
    acceptance: [commandAcceptance()],
    tasks: [task('TASK-1', options.taskOverrides)],
  };
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, graph, options.status ?? 'RUNNING'));
  let snapshotCalls = 0;

  const controller = new DeliveryController({
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

  return { controller, store, repo };
}

// A failing tick leaves the run BLOCKED while the task that was in flight is
// still RUNNING (`runLoop` only rewrites the run status). Before the fix,
// `resume` only re-queued BLOCKED/INTERRUPTED tasks and threw
// "no task can be resumed", leaving no way out of the run.
test('resume takes over a task left RUNNING by a failed tick and completes the run', async () => {
  const { controller, store } = await setup({
    snapshotCreate: async (call) => {
      if (call === 1) throw new Error('snapshot service unavailable');
      return SNAPSHOT;
    },
  });

  await assert.rejects(controller.tick('run-1'), /snapshot service unavailable/);
  const inFlight = (await store.readRun('run-1'))!;
  assert.equal(inFlight.graph.tasks[0]?.status, 'RUNNING');

  // Mirror the run loop's failure handler: it marks the run BLOCKED without
  // touching the in-flight task.
  await store.updateRun('run-1', (draft) => ({
    ...draft,
    status: 'BLOCKED',
    last_error: 'snapshot service unavailable',
  }));

  const resumed = await controller.resume('run-1');

  assert.equal(resumed.status, 'RUNNING');
  assert.equal(resumed.graph.tasks[0]?.status, 'READY');
  assert.equal(resumed.graph.tasks[0]?.attempt, 1);
  assert.deepEqual(resumed.current_task_ids, []);

  const finished = await controller.tick('run-1');
  assert.equal(finished.status, 'COMPLETED');
  assert.equal(finished.graph.tasks[0]?.status, 'DONE');
});

test('resume blocks an in-flight task when taking it over exhausts the retry budget', async () => {
  const { controller, store } = await setup({
    taskOverrides: { status: 'RUNNING', attempt: 2, max_attempts: 3 },
  });
  await store.updateRun('run-1', (draft) => ({ ...draft, status: 'BLOCKED' }));

  await assert.rejects(controller.resume('run-1'), /budget is exhausted/i);

  const state = (await store.readRun('run-1'))!;
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.graph.tasks[0]?.status, 'BLOCKED');
  assert.equal(state.graph.tasks[0]?.attempt, 3);
});

test('recovery consumes an attempt for a task interrupted while executing', async () => {
  const { store } = await setup({
    taskOverrides: { status: 'RUNNING', attempt: 1, max_attempts: 3 },
  });

  const recovered = await recoverInterruptedRun(store, 'run-1');

  assert.equal(recovered.graph.tasks[0]?.status, 'READY');
  assert.equal(recovered.graph.tasks[0]?.attempt, 2);
});

test('recovery blocks the run when the interrupted task has no retry budget left', async () => {
  const { store } = await setup({
    taskOverrides: { status: 'VERIFYING', attempt: 2, max_attempts: 3 },
  });

  const recovered = await recoverInterruptedRun(store, 'run-1');

  assert.equal(recovered.status, 'BLOCKED');
  assert.equal(recovered.graph.tasks[0]?.status, 'BLOCKED');
  assert.equal(recovered.graph.tasks[0]?.attempt, 3);
  assert.match(recovered.last_error ?? '', /recovery/i);
  const events = await readFile(join(store.getRunDirectory('run-1'), 'events.jsonl'), 'utf8');
  assert.match(events, /recovery_attempts_exhausted/);
});

test('the run state machine allows pausing from RUNNING, PLANNING and VERIFYING', () => {
  assert.doesNotThrow(() => assertRunTransition('RUNNING', 'PAUSED'));
  assert.doesNotThrow(() => assertRunTransition('PLANNING', 'PAUSED'));
  assert.doesNotThrow(() => assertRunTransition('VERIFYING', 'PAUSED'));
});

test('pause requested while VERIFYING reaches PAUSED without an invalid transition', async () => {
  const { controller } = await setup({ status: 'VERIFYING' });

  const requested = await controller.pause('run-1');
  assert.equal(requested.pause_requested, true);

  const paused = await controller.tick('run-1');

  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.pause_requested, true);
  assert.notEqual(paused.last_error, 'invalid run transition: VERIFYING -> PAUSED');
});

test('pause requested while RUNNING reaches PAUSED and resume finishes the run', async () => {
  const { controller } = await setup({ status: 'RUNNING' });

  await controller.pause('run-1');
  const paused = await controller.tick('run-1');
  assert.equal(paused.status, 'PAUSED');

  const resumed = await controller.resume('run-1');
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(resumed.pause_requested, false);

  const finished = await controller.tick('run-1');
  assert.equal(finished.status, 'COMPLETED');
});
