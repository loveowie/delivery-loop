import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryController } from '../../src/controller/delivery-controller.js';
import { StateStore } from '../../src/state/state-store.js';
import type {
  AgentRequest,
  AgentResult,
  AcceptanceCondition,
  CodeSnapshot,
  DeliveryConfig,
  EvidenceRecord,
  RunState,
  TaskGraph,
  TaskNode,
} from '../../src/domain/types.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { WorkerRunOptions } from '../../src/workers/worker-adapter.js';

function task(id: string): TaskNode {
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
    scope_paths: [`src/${id}`],
    required_outputs: [],
    worker_role: 'implementer',
    capability_profile: 'portable',
    attempt: 0,
    max_attempts: 3,
    verification_commands: ['npm test'],
    review_policy: 'required',
  };
}

function runState(repo: string, graph: TaskGraph, status: RunState['status'] = 'RUNNING'): RunState {
  const config = structuredClone(DEFAULT_CONFIG as DeliveryConfig);
  config.review.final_review = false;
  return {
    state_schema_version: 1,
    run_id: 'run-1',
    status,
    repo_root: repo,
    created_at: '2026-10-28T00:00:00.000Z',
    updated_at: '2026-10-28T00:00:00.000Z',
    config,
    graph,
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
}

function completedWorker(): AgentResult {
  return {
    task_id: 'TASK-1',
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

function evidence(passed: boolean): EvidenceRecord {
  return {
    id: `E-${passed ? 'pass' : 'fail'}`,
    run_id: 'run-1',
    task_id: 'TASK-1',
    acceptance_ids: ['AC-1'],
    code_snapshot_id: 'SNAP-1',
    command: 'npm test',
    cwd: '/repo',
    started_at: '2026-10-28T00:00:00Z',
    finished_at: '2026-10-28T00:00:01Z',
    exit_code: passed ? 0 : 1,
    stdout_path: '/tmp/stdout.log',
    stderr_path: '/tmp/stderr.log',
    result: passed ? 'passed' : 'failed',
  };
}

async function setupController(
  workerResult: AgentResult | ((request: AgentRequest, options?: WorkerRunOptions) => Promise<AgentResult>),
  verificationPassed: boolean,
  acceptance: AcceptanceCondition[] = [
    {
      id: 'AC-1',
      requirement_id: 'REQ-1',
      description: 'tests pass',
      verification: { type: 'command', command: 'npm test', expected_exit_code: 0 },
      mandatory: true,
      risk: 'low',
    },
  ],
  tasks: TaskNode[] = [task('TASK-1')],
): Promise<{ controller: DeliveryController; state: RunState; store: StateStore }> {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-controller-'));
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'works', status: 'SATISFIED' }],
    acceptance,
    tasks,
  };
  const store = await StateStore.open(repo);
  const state = await store.createRun(runState(repo, graph));
  const snapshot: CodeSnapshot = {
    id: 'SNAP-1',
    created_at: '2026-10-28T00:00:00Z',
    baseline_commit: 'abc',
    worktree_digest: 'digest',
    untracked_files: [],
  };
  const controller = new DeliveryController({
    repoRoot: repo,
    store,
    workers: {
      async run(request, options) {
        return typeof workerResult === 'function' ? await workerResult(request, options) : structuredClone(workerResult);
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
        return { path: repo, cleanup: async () => {} };
      },
    },
    snapshots: {
      async create() {
        return snapshot;
      },
    },
    verifier: {
      async run(request) {
        return { ...evidence(verificationPassed), task_id: request.task_id, acceptance_ids: request.acceptance_ids, command: request.command, code_snapshot_id: request.code_snapshot_id };
      },
    },
    integrator: {
      async integrate() {
        return { ok: true, workdir: repo, snapshot_id: snapshot.id };
      },
    },
  });
  return { controller, state, store };
}

test('failed verification creates a bugfix task instead of completing the run', async () => {
  const { controller } = await setupController(completedWorker(), false);

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'RUNNING');
  assert.equal(state.graph.tasks[0]?.status, 'FIX_REQUIRED');
  assert.ok(state.graph.tasks.some((candidate) => candidate.origin === 'test_failure'));
});

test('review findings create a review fix task', async () => {
  const { controller } = await setupController(async (request) => ({
    ...completedWorker(),
    task_id: request.task_id,
    findings:
      request.role === 'reviewer'
        ? [
            {
              id: 'F-1',
              severity: 'P1',
              title: 'missing case',
              description: 'edge case missing',
              evidence: 'diff',
            },
          ]
        : [],
  }), true);
  const state = await controller.tick('run-1');

  assert.equal(state.graph.tasks[0]?.status, 'FIX_REQUIRED');
  assert.ok(state.graph.tasks.some((candidate) => candidate.origin === 'review_finding'));
});

test('successful integration and acceptance complete the run', async () => {
  const { controller } = await setupController(completedWorker(), true);

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.graph.tasks[0]?.status, 'DONE');
});

test('manual acceptance response records evidence and completes the run', async () => {
  const { controller, store } = await setupController(completedWorker(), true, [
    {
      id: 'AC-1',
      requirement_id: 'REQ-1',
      description: 'user approves',
      verification: { type: 'manual' },
      mandatory: true,
      risk: 'low',
    },
  ]);
  await store.updateRun('run-1', (state) => ({
    ...state,
    status: 'WAITING_HUMAN',
    pending_decision_ids: ['AC-1'],
    integration_snapshot_id: 'SNAP-1',
    graph: { ...state.graph, tasks: [] },
  }));

  const state = await controller.respond('run-1', 'AC-1', 'approved');

  assert.equal(state.status, 'COMPLETED');
  assert.deepEqual(state.pending_decision_ids, []);
});

test('ready implementation tasks run concurrently up to the worker limit', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let bothStarted!: () => void;
  const gate = new Promise<void>(resolve => { bothStarted = resolve; });
  const parallelTasks = [
    { ...task('TASK-A'), review_policy: 'none' as const, verification_commands: ['npm test'] },
    { ...task('TASK-B'), review_policy: 'none' as const, verification_commands: ['npm test'] },
  ];
  const { controller } = await setupController(
    async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 2) bothStarted();
      await gate;
      inFlight -= 1;
      return { ...completedWorker(), task_id: request.task_id };
    },
    true,
    [],
    parallelTasks,
  );

  const state = await controller.tick('run-1');

  assert.equal(maxInFlight, 2);
  assert.equal(state.status, 'COMPLETED');
});

test('reviewer infrastructure failure retries instead of integrating', async () => {
  const { controller } = await setupController(async (request) => {
    if (request.role === 'reviewer') {
      return {
        ...completedWorker(),
        status: 'failed',
        summary: 'reviewer crashed',
      };
    }
    return completedWorker();
  }, true);

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'RUNNING');
  assert.equal(state.graph.tasks[0]?.status, 'READY');
  assert.equal(state.graph.tasks[0]?.attempt, 1);
});

test('dynamic task budget exhaustion blocks instead of growing the graph', async () => {
  const { controller, store } = await setupController(completedWorker(), false);
  await store.updateRun('run-1', (state) => ({
    ...state,
    config: {
      ...state.config,
      runtime: { ...state.config.runtime, max_dynamic_tasks: 0 },
    },
  }));

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.graph.tasks.some((candidate) => candidate.origin === 'test_failure'), false);
});

test('worker failure returns the task to ready for a bounded retry', async () => {
  const { controller } = await setupController(async (request) => ({
    ...completedWorker(),
    task_id: request.task_id,
    status: 'failed',
    summary: 'worker process unavailable',
  }), false);

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'RUNNING');
  assert.equal(state.graph.tasks[0]?.status, 'READY');
  assert.equal(state.graph.tasks[0]?.attempt, 1);
  assert.equal(state.graph.tasks.some((task) => task.origin === 'test_failure'), false);
});

test('successful repair task returns its source task to execution', async () => {
  let verificationCalls = 0;
  const { controller, store } = await setupController(completedWorker(), true);
  const existing = await store.readRun('run-1');
  assert.ok(existing);
  const controllerWithFailingFirstCheck = new DeliveryController({
    repoRoot: existing.repo_root,
    store,
    workers: {
      async run(request) {
        return { ...completedWorker(), task_id: request.task_id };
      },
    },
    skills: { async resolve() { return []; }, async verifyAll() {} },
    worktrees: {
      async prepare() {
        return { path: existing.repo_root, cleanup: async () => {} };
      },
    },
    snapshots: {
      async create() {
        return { id: 'SNAP-1', created_at: '', baseline_commit: 'abc', worktree_digest: 'x', untracked_files: [] };
      },
    },
    verifier: {
      async run(request) {
        verificationCalls += 1;
        return {
          id: `E-${verificationCalls}`,
          run_id: request.run_id,
          task_id: request.task_id,
          acceptance_ids: request.acceptance_ids,
          code_snapshot_id: request.code_snapshot_id,
          command: request.command,
          cwd: request.cwd,
          started_at: '',
          finished_at: '',
          exit_code: verificationCalls === 1 ? 1 : 0,
          stdout_path: '',
          stderr_path: '',
          result: verificationCalls === 1 ? 'failed' : 'passed',
        };
      },
    },
    integrator: { async integrate() { return { ok: true, workdir: store.repoRoot, snapshot_id: 'SNAP-1' }; } },
  });
  void controller;

  await controllerWithFailingFirstCheck.tick('run-1');
  await controllerWithFailingFirstCheck.tick('run-1');
  await controllerWithFailingFirstCheck.tick('run-1');
  const state = await store.readRun('run-1');

  assert.equal(state?.status, 'COMPLETED');
  assert.equal(state?.graph.tasks.find((task) => task.id === 'TASK-1')?.status, 'DONE');
});

test('worker blockers map decisions back to interrupted tasks', async () => {
  const { controller } = await setupController(async (request) => ({
    ...completedWorker(),
    task_id: request.task_id,
    status: 'blocked',
    summary: 'choice required',
    blockers: [
      {
        decision_id: 'DECISION-1',
        type: 'requirement',
        question: 'Which behavior?',
        options: ['A', 'B'],
        affected_task_ids: [request.task_id],
      },
    ],
  }), true);

  const waiting = await controller.tick('run-1');
  assert.equal(waiting.status, 'WAITING_HUMAN');
  assert.equal(waiting.graph.tasks[0]?.status, 'INTERRUPTED');

  const resumed = await controller.respond('run-1', 'DECISION-1', 'A');
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(resumed.graph.tasks[0]?.status, 'READY');
});

test('real manual acceptance decision id is directly answerable', async () => {
  const { controller, store } = await setupController(completedWorker(), true, [
    {
      id: 'AC-1',
      requirement_id: 'REQ-1',
      description: 'approve',
      verification: { type: 'manual' },
      mandatory: true,
      risk: 'low',
    },
  ], []);
  await store.updateRun('run-1', (state) => ({
    ...state,
    integration_snapshot_id: 'SNAP-1',
  }));

  const waiting = await controller.tick('run-1');
  assert.deepEqual(waiting.pending_decision_ids, ['AC-1']);
  const completed = await controller.respond('run-1', 'AC-1', 'approved');
  assert.equal(completed.status, 'COMPLETED');
});

test('manual rejection keeps the run waiting and records no approval', async () => {
  const { controller, store } = await setupController(completedWorker(), true, [
    {
      id: 'AC-1',
      requirement_id: 'REQ-1',
      description: 'approve',
      verification: { type: 'manual' },
      mandatory: true,
      risk: 'low',
    },
  ], []);
  await store.updateRun('run-1', (state) => ({ ...state, integration_snapshot_id: 'SNAP-1' }));
  await controller.tick('run-1');

  const rejected = await controller.respond('run-1', 'AC-1', 'rejected: not acceptable');

  assert.equal(rejected.status, 'WAITING_HUMAN');
  assert.deepEqual(rejected.pending_decision_ids, ['AC-1']);
});

test('final independent review runs before completion when configured', async () => {
  const { controller, store } = await setupController(
    async (request) => ({ ...completedWorker(), task_id: request.task_id }),
    true,
    [],
    [{ ...task('TASK-1'), review_policy: 'none' }],
  );
  await store.updateRun('run-1', (state) => ({
    ...state,
    config: { ...state.config, review: { ...state.config.review, final_review: true } },
  }));

  const first = await controller.tick('run-1');
  assert.equal(first.status, 'RUNNING');
  assert.ok(first.graph.tasks.some((candidate) => candidate.id === 'FINAL-REVIEW'));
  const second = await controller.tick('run-1');
  assert.equal(second.status, 'COMPLETED');
});

test('out-of-scope file changes block integration', async () => {
  const { controller, store } = await setupController(completedWorker(), true, [], [
    { ...task('TASK-1'), review_policy: 'none', verification_commands: [] },
  ]);
  const runtime = controller as unknown as {
    options: { snapshots: { changedFiles?: (workdir: string) => Promise<string[]> } };
  };
  runtime.options.snapshots.changedFiles = async () => ['outside/secret.ts'];

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'BLOCKED');
  assert.match(state.last_error ?? '', /scope/i);
});

test('configured final verification matrix runs against the integration snapshot', async () => {
  const { controller, store } = await setupController(completedWorker(), true, [], [
    { ...task('TASK-1'), review_policy: 'none', verification_commands: ['final-check'], required_outputs: [] },
  ]);
  await store.updateRun('run-1', (state) => ({
    ...state,
    config: {
      ...state.config,
      verification: {
        ...state.config.verification,
        commands: { build: [], test: ['final-check'], lint: [], e2e: [] },
      },
    },
  }));
  const commands: string[] = [];
  const runtime = controller as unknown as {
    options: { verifier: { run: (request: { command: string }) => Promise<unknown> } };
  };
  const originalRun = runtime.options.verifier.run;
  runtime.options.verifier.run = async (request) => {
    commands.push(request.command);
    return await originalRun(request as never);
  };

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'COMPLETED');
  assert.ok(commands.includes('final-check'));
});

test('baseline verification runs once before scheduling when configured', async () => {
  const { controller, store } = await setupController(completedWorker(), true);
  await store.updateRun('run-1', (state) => ({
    ...state,
    config: {
      ...state.config,
      verification: {
        ...state.config.verification,
        baseline: true,
        commands: { build: [], test: ['baseline-check'], lint: [], e2e: [] },
      },
    },
  }));
  const commands: string[] = [];
  const runtime = controller as unknown as {
    options: { verifier: { run: (request: { command: string }) => Promise<unknown> } };
  };
  const originalRun = runtime.options.verifier.run;
  runtime.options.verifier.run = async (request) => {
    commands.push(request.command);
    return await originalRun(request as never);
  };

  const started = await controller.start('run-1');

  assert.equal(started.status, 'RUNNING');
  assert.ok(commands.includes('baseline-check'));
  assert.ok(started.baseline_verification_id);
});

test('dynamic repair depth exhaustion blocks further repair chains', async () => {
  const { controller, store } = await setupController(completedWorker(), false, [], [
    { ...task('TASK-1'), dynamic_depth: 3, review_policy: 'none' },
  ]);
  await store.updateRun('run-1', (state) => ({
    ...state,
    config: { ...state.config, runtime: { ...state.config.runtime, max_dynamic_depth: 3 } },
  }));

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.graph.tasks.some((candidate) => candidate.origin === 'test_failure'), false);
});

test('token budget exhaustion blocks integration', async () => {
  const { controller, store } = await setupController(async (request) => ({
    ...completedWorker(),
    task_id: request.task_id,
    token_usage: 100,
  }), true);
  await store.updateRun('run-1', (state) => ({
    ...state,
    config: { ...state.config, runtime: { ...state.config.runtime, max_total_tokens: 50 } },
  }));

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.total_tokens_used, 100);
});

test('required outputs with no actual file changes block integration', async () => {
  const { controller } = await setupController(completedWorker(), true, [], [
    { ...task('TASK-1'), review_policy: 'none', verification_commands: [], required_outputs: ['code'] },
  ]);
  const runtime = controller as unknown as {
    options: { snapshots: { changedFiles?: (workdir: string) => Promise<string[]> } };
  };
  runtime.options.snapshots.changedFiles = async () => [];

  const state = await controller.tick('run-1');

  assert.equal(state.status, 'BLOCKED');
  assert.match(state.last_error ?? '', /required_outputs/i);
});

test('cancel fences integration after an in-flight worker returns', async () => {
  let releaseWorker!: () => void;
  let aborted = false;
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  let workerStarted!: () => void;
  const started = new Promise<void>(resolve => { workerStarted = resolve; });
  const { controller } = await setupController(async (request, options) => {
    workerStarted();
    options?.signal?.addEventListener('abort', () => {
      aborted = true;
      releaseWorker();
    }, { once: true });
    await workerGate;
    return { ...completedWorker(), task_id: request.task_id };
  }, true);
  let integrations = 0;
  const runtime = controller as unknown as {
    options: { integrator: { integrate: () => Promise<unknown> } };
  };
  const originalIntegrate = runtime.options.integrator.integrate;
  runtime.options.integrator.integrate = async () => {
    integrations += 1;
    return await originalIntegrate();
  };

  const ticking = controller.tick('run-1');
  await started;
  await controller.cancel('run-1');
  releaseWorker();
  const state = await ticking;

  assert.equal(state.status, 'CANCELLED');
  assert.equal(state.graph.tasks[0]?.status, 'CANCELLED');
  assert.equal(integrations, 0);
  assert.equal(aborted, true);
});
