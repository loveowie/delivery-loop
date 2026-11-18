import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryController } from '../../src/controller/delivery-controller.js';
import { StateStore } from '../../src/state/state-store.js';
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

type Manifest = NonNullable<CodeSnapshot['content_manifest']>;

interface ContentState {
  current: Manifest;
}

function fileEntry(digest: string): Manifest[string] {
  return { type: 'file', mode: '100644', digest };
}

/**
 * Deterministic snapshot stub: the id is derived from the manifest, mirroring
 * the real `createCodeSnapshot` contract closely enough for the controller to
 * compare snapshots and to notice repaired content.
 */
function snapshotFor(manifest: Manifest): CodeSnapshot {
  const hash = createHash('sha256');
  const entries = Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right));
  for (const [path, entry] of entries) {
    hash.update(path);
    hash.update('\0');
    hash.update(entry.type);
    hash.update('\0');
    hash.update(entry.mode);
    hash.update('\0');
    hash.update(entry.digest);
    hash.update('\0');
  }
  const worktreeDigest = hash.digest('hex');
  return {
    id: `SNAP-${worktreeDigest.slice(0, 12)}`,
    created_at: '2026-11-17T00:00:00.000Z',
    baseline_commit: 'abc123',
    worktree_digest: worktreeDigest,
    content_manifest: structuredClone(manifest),
    untracked_files: [],
  };
}

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
    verification_commands: [],
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

function runState(repo: string, graph: TaskGraph): RunState {
  const config = structuredClone(DEFAULT_CONFIG as DeliveryConfig);
  config.review.final_review = false;
  return {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'RUNNING',
    repo_root: repo,
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

function verificationEvidence(
  request: VerificationRequest,
  index: number,
  result: 'passed' | 'failed',
): EvidenceRecord {
  return {
    id: `E-${index}`,
    run_id: request.run_id,
    task_id: request.task_id,
    acceptance_ids: request.acceptance_ids,
    code_snapshot_id: request.code_snapshot_id,
    command: request.command,
    cwd: request.cwd,
    started_at: '2026-11-17T00:00:00.000Z',
    finished_at: '2026-11-17T00:00:01.000Z',
    exit_code: result === 'passed' ? 0 : 1,
    stdout_path: '',
    stderr_path: '',
    result,
  };
}

interface SetupOptions {
  tasks: TaskNode[];
  acceptance?: AcceptanceCondition[];
  worker: (request: AgentRequest, content: ContentState) => Promise<AgentResult>;
  verify?: (request: VerificationRequest, index: number) => EvidenceRecord;
}

async function setup(options: SetupOptions): Promise<{ controller: DeliveryController; store: StateStore }> {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-repair-'));
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'works', status: 'SATISFIED' }],
    acceptance: options.acceptance ?? [commandAcceptance()],
    tasks: options.tasks,
  };
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, graph));

  const content: ContentState = { current: { 'README.md': fileEntry('readme') } };
  const integrationWorktree = join(repo, 'integration-worktree');
  let verificationCalls = 0;

  const controller = new DeliveryController({
    repoRoot: repo,
    store,
    workers: {
      async run(request) {
        return await options.worker(request, content);
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
        return { path: integrationWorktree, cleanup: async () => {} };
      },
    },
    snapshots: {
      async create() {
        return snapshotFor(content.current);
      },
      // The repair regression must exercise the real content-manifest branch,
      // never the legacy `files_changed` fallback.
      async changedFiles() {
        throw new Error('snapshot changedFiles fallback must not be used when content manifests exist');
      },
    },
    verifier: {
      async run(request) {
        verificationCalls += 1;
        if (options.verify !== undefined) return options.verify(request, verificationCalls);
        return verificationEvidence(request, verificationCalls, 'passed');
      },
    },
    integrator: {
      async integrate() {
        return {
          ok: true,
          workdir: integrationWorktree,
          snapshot_id: snapshotFor(content.current).id,
        };
      },
    },
  });

  return { controller, store };
}

test('a repaired task finishes instead of being blocked by required_outputs from an empty repair diff', async () => {
  let sourceAttempts = 0;
  const { controller, store } = await setup({
    tasks: [
      // The first attempt writes src/task.ts and fails verification. The repair
      // task commits that content, and when the source task runs again its
      // manifest diff against the repaired worktree is empty.
      task('TASK-1', { required_outputs: ['code'], verification_commands: ['verify-task'] }),
    ],
    worker: async (request, content) => {
      if (request.task_id === 'TASK-1') {
        sourceAttempts += 1;
        if (sourceAttempts === 1) {
          content.current = { ...content.current, 'src/task.ts': fileEntry('v1') };
        }
        return completed('TASK-1');
      }
      content.current = {
        ...content.current,
        'src/task.ts': fileEntry('v2'),
        'src/fix.ts': fileEntry('fix'),
      };
      return completed(request.task_id);
    },
    verify: (request, index) => verificationEvidence(request, index, index === 1 ? 'failed' : 'passed'),
  });

  const statuses: RunState['status'][] = [];
  let state = await store.readRun('run-1');
  assert.ok(state);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    state = await controller.tick('run-1');
    statuses.push(state.status);
    if (state.status === 'COMPLETED' || state.status === 'BLOCKED' || state.status === 'CANCELLED') break;
  }

  assert.ok(statuses.length > 0);
  assert.deepEqual(statuses.filter((status) => status === 'BLOCKED'), []);
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.graph.tasks.find((candidate) => candidate.id === 'TASK-1')?.status, 'DONE');
  // The source ran twice: the failing attempt and the post-repair attempt whose
  // content manifest is identical to the repaired seed.
  assert.equal(sourceAttempts, 2);
  const repaired = state.graph.tasks.find((candidate) => candidate.id === 'TASK-1');
  assert.deepEqual(repaired?.changed_files, []);
  assert.deepEqual(repaired?.required_outputs, []);
  const fixTask = state.graph.tasks.find((candidate) => candidate.origin === 'test_failure');
  assert.ok(fixTask);
  assert.equal(fixTask.status, 'DONE');
});

test('a blocker that names its reporting task more than once stores it once', async () => {
  const { controller } = await setup({
    tasks: [task('TASK-1')],
    worker: async (request) => ({
      ...completed(request.task_id),
      status: 'blocked',
      summary: 'need a human decision',
      blockers: [
        {
          decision_id: 'DECISION-1',
          type: 'requirement',
          question: 'Which behavior should be kept?',
          options: ['A'],
          affected_task_ids: ['TASK-1', 'TASK-2', 'TASK-1'],
        },
      ],
    }),
  });

  const waiting = await controller.tick('run-1');

  assert.equal(waiting.status, 'WAITING_HUMAN');
  assert.deepEqual(waiting.pending_decision_tasks?.['DECISION-1'], ['TASK-1', 'TASK-2']);
});

test('a blocker that omits its reporting task still requeues that task for a human answer', async () => {
  let workerCalls = 0;
  const { controller, store } = await setup({
    tasks: [task('TASK-1')],
    worker: async (request) => {
      workerCalls += 1;
      if (workerCalls === 1) {
        return {
          ...completed(request.task_id),
          status: 'blocked',
          summary: 'need a human decision',
          blockers: [
            {
              decision_id: 'DECISION-1',
              type: 'requirement',
              question: 'Which behavior should be kept?',
              options: ['A', 'B'],
              affected_task_ids: ['TASK-2'],
            },
          ],
        };
      }
      return completed(request.task_id);
    },
  });

  const waiting = await controller.tick('run-1');
  assert.equal(waiting.status, 'WAITING_HUMAN');
  const interrupted = waiting.graph.tasks.find((candidate) => candidate.id === 'TASK-1');
  assert.equal(interrupted?.status, 'INTERRUPTED');
  const blockedTasks = waiting.pending_decision_tasks?.['DECISION-1'] ?? [];
  assert.ok(
    blockedTasks.includes('TASK-1'),
    `blocker must always map back to its reporting task, got ${JSON.stringify(blockedTasks)}`,
  );

  const resumed = await controller.respond('run-1', 'DECISION-1', 'A');
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(resumed.graph.tasks.find((candidate) => candidate.id === 'TASK-1')?.status, 'READY');
  assert.deepEqual(resumed.pending_decision_ids, []);

  const completedRun = await controller.tick('run-1');
  assert.equal(completedRun.status, 'COMPLETED');
  assert.equal(completedRun.graph.tasks.find((candidate) => candidate.id === 'TASK-1')?.status, 'DONE');

  const persisted = await store.readRun('run-1');
  assert.equal(persisted?.status, 'COMPLETED');
});
