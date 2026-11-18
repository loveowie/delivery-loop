import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryController } from '../../src/controller/delivery-controller.js';
import { PreparedRunFactory } from '../../src/controller/run-factory.js';
import { StateStore } from '../../src/state/state-store.js';
import { EvidenceLedger } from '../../src/state/evidence-ledger.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
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
    scope_paths: [],
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

function manualAcceptance(): AcceptanceCondition {
  return {
    id: 'AC-1',
    requirement_id: 'REQ-1',
    description: 'human approves the delivered content',
    verification: { type: 'manual' },
    mandatory: true,
    risk: 'low',
  };
}

function runState(repo: string, graph: TaskGraph, config: DeliveryConfig): RunState {
  return {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'RUNNING',
    repo_root: repo,
    baseline_commit: 'base',
    created_at: '2026-11-17T00:00:00.000Z',
    updated_at: '2026-11-17T00:00:00.000Z',
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

function verificationEvidence(request: VerificationRequest, passed: boolean): EvidenceRecord {
  return {
    id: `E-${request.task_id}-${request.command}-${request.code_snapshot_id}`,
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

interface WorkerContext {
  repo: string;
  content: Map<string, string>;
}

interface FixtureOptions {
  graph: TaskGraph;
  configure?: (config: DeliveryConfig) => void;
  worker?: (request: AgentRequest, context: WorkerContext) => AgentResult | Promise<AgentResult>;
}

/**
 * Snapshot ids are derived from the content a worktree path was seeded with, so
 * reusing a worktree path yields the stale snapshot while a new attempt path
 * seeded from the accepted integration worktree observes the new content.
 */
async function fixture(options: FixtureOptions) {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-review-acceptance-'));
  const store = await StateStore.open(repo);
  const ledger = new EvidenceLedger(repo);
  const config = structuredClone(DEFAULT_CONFIG) as DeliveryConfig;
  config.review.final_review = false;
  config.verification.commands = { build: [], test: [], lint: [], e2e: [] };
  options.configure?.(config);
  await store.createRun(runState(repo, options.graph, config));

  const content = new Map<string, string>();
  const snapshotFor = (workdir: string): CodeSnapshot => {
    const value = content.get(workdir) ?? 'baseline';
    const id = `SNAP-${createHash('sha256').update(value).digest('hex').slice(0, 10)}`;
    return {
      id,
      created_at: '2026-11-17T00:00:00.000Z',
      baseline_commit: 'base',
      worktree_digest: id,
      untracked_files: [],
    };
  };

  const preparedPaths: Array<{ task_id: string; attempt: number; seed?: string }> = [];
  const requests: AgentRequest[] = [];
  const workerBehavior = options.worker ?? ((request: AgentRequest) => completed(request.task_id));
  let verificationBehavior: (request: VerificationRequest) => 'passed' | 'failed' = () => 'passed';
  let integrations = 0;

  const controller = new DeliveryController({
    repoRoot: repo,
    store,
    evidenceLedger: ledger,
    workers: {
      async run(request) {
        requests.push(request);
        return await workerBehavior(request, { repo, content });
      },
    },
    skills: {
      async resolve() {
        return [];
      },
      async verifyAll() {},
    },
    worktrees: {
      async prepare(_state, current, seed) {
        preparedPaths.push({
          task_id: current.id,
          attempt: current.attempt,
          ...(seed === undefined ? {} : { seed }),
        });
        const path = join(repo, 'worktrees', `${current.id}-attempt-${current.attempt}`);
        if (!content.has(path)) {
          content.set(path, seed === undefined ? 'baseline' : content.get(seed) ?? 'baseline');
        }
        return { path, cleanup: async () => {} };
      },
    },
    snapshots: {
      async create(workdir) {
        return snapshotFor(workdir);
      },
      async changedFiles() {
        return [];
      },
    },
    verifier: {
      async run(request) {
        return verificationEvidence(request, verificationBehavior(request) === 'passed');
      },
    },
    integrator: {
      async integrate(_state, _task, workdir) {
        integrations += 1;
        const path = join(repo, 'integration', String(integrations));
        content.set(path, `${content.get(workdir) ?? 'baseline'}|integration-${integrations}`);
        return { ok: true, workdir: path, snapshot_id: snapshotFor(path).id };
      },
    },
  });

  return {
    repo,
    store,
    controller,
    ledger,
    content,
    preparedPaths,
    requests,
    setVerification(behavior: (request: VerificationRequest) => 'passed' | 'failed') {
      verificationBehavior = behavior;
    },
  };
}

// A final review only exists to review accepted integration content. With no
// integration snapshot the review never binds to a snapshot and the
// DONE -> READY reset fires on every tick, so the run can never complete.
test('final review is skipped without an accepted integration snapshot and approval still completes', async () => {
  const f = await fixture({
    graph: {
      run_id: 'run-1',
      requirements: [{ id: 'REQ-1', description: 'works', status: 'PENDING' }],
      acceptance: [manualAcceptance()],
      tasks: [],
    },
    configure: (config) => {
      config.review.final_review = true;
    },
  });

  let state = await f.controller.tick('run-1');
  assert.equal(state.status, 'WAITING_HUMAN', state.last_error ?? '');
  assert.equal(
    state.graph.tasks.some((candidate) => candidate.id === 'FINAL-REVIEW'),
    false,
  );

  state = await f.controller.tick('run-1');
  assert.equal(state.status, 'WAITING_HUMAN');
  assert.equal(
    state.graph.tasks.some((candidate) => candidate.id === 'FINAL-REVIEW'),
    false,
  );

  const approved = await f.controller.respond('run-1', 'AC-1', 'approved');
  assert.equal(approved.status, 'COMPLETED', approved.last_error ?? '');
  assert.deepEqual(approved.pending_decision_ids, []);
});

// `respond` used to bind the manual approval to
// `integration_snapshot_id ?? 'NO-INTEGRATION-SNAPSHOT'` while acceptance
// evaluated the last task snapshot; the approval was silently discarded and the
// same decision was re-queued forever.
test('approval-only delivery binds approval to the accepted content snapshot', async () => {
  const f = await fixture({
    graph: {
      run_id: 'run-1',
      requirements: [{ id: 'REQ-1', description: 'works', status: 'PENDING' }],
      acceptance: [manualAcceptance()],
      tasks: [
        task('REVIEW-1', {
          type: 'verification',
          title: 'review the deliverable',
          worker_role: 'reviewer',
          verification_commands: [],
          review_policy: 'none',
        }),
      ],
    },
    configure: (config) => {
      config.review.final_review = true;
    },
  });

  const waiting = await f.controller.tick('run-1');
  assert.equal(waiting.status, 'WAITING_HUMAN', waiting.last_error ?? '');
  assert.equal(
    waiting.graph.tasks.some((candidate) => candidate.id === 'FINAL-REVIEW'),
    false,
  );
  const reviewed = waiting.graph.tasks.find((candidate) => candidate.id === 'REVIEW-1');
  assert.ok(reviewed?.code_snapshot_id !== undefined);

  const approved = await f.controller.respond('run-1', 'AC-1', 'approved');
  assert.equal(approved.status, 'COMPLETED', approved.last_error ?? '');
  assert.deepEqual(approved.pending_decision_ids, []);

  const approval = (await f.ledger.readAll('run-1')).find(
    (record) => record.command === 'manual-approval',
  );
  assert.ok(approval);
  assert.equal(approval.code_snapshot_id, reviewed?.code_snapshot_id);
});

// "final review -> repair task -> integration -> re-review" used to reset the
// review to READY without claiming a new attempt. The attempt-0 worktree (old
// content) was reused, the reviewed snapshot never matched the new integration
// snapshot, and the run was reset forever.
test('final review re-reviews fresh content after a repair changes the accepted snapshot', async () => {
  const f = await fixture({
    graph: {
      run_id: 'run-1',
      requirements: [{ id: 'REQ-1', description: 'works', status: 'PENDING' }],
      acceptance: [
        {
          id: 'AC-1',
          requirement_id: 'REQ-1',
          description: 'acceptance check passes',
          verification: { type: 'command', command: 'acceptance-check', expected_exit_code: 0 },
          mandatory: true,
          risk: 'low',
        },
      ],
      tasks: [task('TASK-1', { verification_commands: ['npm test'] })],
    },
    configure: (config) => {
      config.review.final_review = true;
    },
    worker: (request, context) => {
      // The acceptance repair task changes the accepted content.
      if (request.task_id.startsWith('FIX-')) {
        context.content.set(
          request.workdir,
          `${context.content.get(request.workdir) ?? 'baseline'}|repaired`,
        );
      }
      return completed(request.task_id);
    },
  });
  const firstIntegration = join(f.repo, 'integration', '1');
  f.setVerification((request) =>
    request.command === 'acceptance-check' && request.cwd === firstIntegration ? 'failed' : 'passed',
  );

  let state = await f.controller.tick('run-1');
  for (let cycle = 0; cycle < 12 && !['COMPLETED', 'BLOCKED'].includes(state.status); cycle += 1) {
    state = await f.controller.tick('run-1');
  }

  assert.equal(state.status, 'COMPLETED', state.last_error ?? '');
  const finalReview = state.graph.tasks.find((candidate) => candidate.id === 'FINAL-REVIEW');
  assert.ok(finalReview);
  assert.equal(finalReview.status, 'DONE');
  // Resetting the review must claim a new attempt (fresh worktree) and keep
  // retry budget taken from the run configuration.
  assert.equal(finalReview.attempt, 1);
  assert.equal(finalReview.code_snapshot_id, state.integration_snapshot_id);
  assert.deepEqual(
    f.preparedPaths
      .filter((entry) => entry.task_id === 'FINAL-REVIEW')
      .map((entry) => entry.attempt),
    [0, 1],
  );
  assert.equal(
    f.requests.filter((request) => request.task_id === 'FINAL-REVIEW').length,
    2,
  );
});

test('prepared run factory rejects a contract with no requirement or mandatory acceptance', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-contract-reject-'));
  const prepared = join(repo, 'prepared');
  await mkdir(prepared, { recursive: true });
  await writeFile(join(prepared, 'spec.md'), '# Spec\n');
  await writeFile(
    join(prepared, 'task-graph.json'),
    JSON.stringify({ run_id: 'draft', tasks: [], requirements: [], acceptance: [] }),
  );
  const factory = new PreparedRunFactory({
    async inspect() {
      return { canonical_root: repo, baseline_commit: 'base' };
    },
  });

  await assert.rejects(
    factory.create({ repo_root: repo, prepared_directory: prepared, run_id: 'run-1' }),
    /requirement|mandatory acceptance/i,
  );
});

test('controller start rejects an unsatisfiable delivery contract', async () => {
  const f = await fixture({
    graph: { run_id: 'run-1', requirements: [], acceptance: [], tasks: [] },
  });

  await assert.rejects(f.controller.start('run-1'), /requirement|mandatory acceptance/i);
});
