import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryController } from '../../src/controller/delivery-controller.js';
import { StateStore } from '../../src/state/state-store.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type {
  AgentResult,
  DeliveryConfig,
  EvidenceRecord,
  RunState,
  TaskGraph,
  TaskNode,
  CodeSnapshot,
} from '../../src/domain/types.js';

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
    requirement_ids: [],
    acceptance_ids: [],
    scope_paths: [`src/${id}`],
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

function runState(repo: string, graph: TaskGraph): RunState {
  const config = structuredClone(DEFAULT_CONFIG as DeliveryConfig);
  config.review.final_review = false;
  config.verification.commands = { build: [], test: [], lint: [], e2e: [] };
  return {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'RUNNING',
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

function completed(taskId: string, overrides: Partial<AgentResult> = {}): AgentResult {
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
    ...overrides,
  };
}

async function fixture(graph: TaskGraph, options: {
  worker?: (taskId: string) => AgentResult;
  artifact?: { path: string; sha256: string };
} = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-acceptance-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState(repo, graph));
  const snapshots = new Map<string, CodeSnapshot>();
  const snapshotFor = (workdir: string): CodeSnapshot => {
    const existing = snapshots.get(workdir);
    if (existing !== undefined) return existing;
    const id = `SNAP-${createHash('sha256').update(workdir).digest('hex').slice(0, 8)}`;
    const snapshot: CodeSnapshot = {
      id,
      created_at: new Date().toISOString(),
      baseline_commit: 'base',
      worktree_digest: id,
      untracked_files: [],
      content_manifest: {},
    };
    snapshots.set(workdir, snapshot);
    return snapshot;
  };
  let integrations = 0;
  const controller = new DeliveryController({
    repoRoot: repo,
    store,
    workers: {
      async run(request) {
        return (options.worker ?? ((taskId) => completed(taskId)))(request.task_id);
      },
    },
    skills: { async resolve() { return []; }, async verifyAll() {} },
    worktrees: {
      async prepare(_state, current) {
        return { path: join(repo, 'worktrees', `${current.id}-${current.attempt}`), cleanup: async () => {} };
      },
    },
    snapshots: {
      async create(workdir) { return snapshotFor(workdir); },
      async changedFiles() { return []; },
    },
    verifier: {
      async run(request) {
        const record: EvidenceRecord = {
          id: `E-${request.task_id}-${request.code_snapshot_id}-${createHash('sha256').update(request.command).digest('hex').slice(0, 6)}`,
          run_id: request.run_id,
          task_id: request.task_id,
          acceptance_ids: request.acceptance_ids,
          code_snapshot_id: request.code_snapshot_id,
          command: request.command,
          cwd: request.cwd,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          exit_code: 0,
          stdout_path: '',
          stderr_path: '',
          result: 'passed',
        };
        return record;
      },
    },
    integrator: {
      async integrate() {
        integrations += 1;
        const workdir = join(repo, 'integration', String(integrations));
        return {
          ok: true,
          workdir,
          snapshot_id: snapshotFor(workdir).id,
          ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
        };
      },
    },
  });
  return { repo, store, controller };
}

test('requirement evidence is re-established at the final snapshot for earlier tasks', async () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [
      { id: 'REQ-1', description: 'uncovered by acceptance', status: 'PENDING' },
      { id: 'REQ-2', description: 'covered by acceptance', status: 'PENDING' },
    ],
    acceptance: [{
      id: 'AC-2',
      requirement_id: 'REQ-2',
      description: 'tests pass',
      verification: { type: 'command', command: 'npm test', expected_exit_code: 0 },
      mandatory: true,
      risk: 'low',
    }],
    tasks: [
      task('T1', { requirement_ids: ['REQ-1'], verification_commands: ['npm test'] }),
      task('T2', { requirement_ids: ['REQ-2'], acceptance_ids: ['AC-2'], depends_on: ['T1'], verification_commands: ['npm test'] }),
    ],
  };
  const { controller } = await fixture(graph);
  await controller.tick('run-1');
  await controller.tick('run-1');
  const state = await controller.tick('run-1');
  assert.equal(state.status, 'COMPLETED', state.last_error ?? '');
  assert.equal(state.graph.requirements?.every((requirement) => requirement.status === 'SATISFIED'), true);
});

test('mandatory artifact acceptance is satisfied by the delivery artifact digest', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-artifact-'));
  const artifactPath = join(repo, 'delivery.patch');
  await writeFile(artifactPath, 'diff --git a/x b/x\n');
  const sha256 = createHash('sha256').update('diff --git a/x b/x\n').digest('hex');
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'artifact exists', status: 'PENDING' }],
    acceptance: [{
      id: 'AC-ART',
      requirement_id: 'REQ-1',
      description: 'patch artifact',
      verification: { type: 'artifact' },
      mandatory: true,
      risk: 'low',
    }],
    tasks: [task('T1', { requirement_ids: ['REQ-1'], verification_commands: ['npm test'] })],
  };
  const { controller } = await fixture(graph, { artifact: { path: artifactPath, sha256 } });
  await controller.tick('run-1');
  await controller.tick('run-1');
  const state = await controller.tick('run-1');
  assert.equal(state.status, 'COMPLETED', state.last_error ?? '');
  assert.equal(state.completion_ref !== undefined, true);
});

test('a blocked worker without blockers still produces an answerable decision', async () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'works', status: 'PENDING' }],
    acceptance: [{
      id: 'AC-1',
      requirement_id: 'REQ-1',
      description: 'tests pass',
      verification: { type: 'command', command: 'npm test', expected_exit_code: 0 },
      mandatory: true,
      risk: 'low',
    }],
    tasks: [task('T1', { requirement_ids: ['REQ-1'], acceptance_ids: ['AC-1'] })],
  };
  const { controller } = await fixture(graph, {
    worker: (taskId) => completed(taskId, { status: 'blocked', summary: 'needs a choice', blockers: [] }),
  });
  const waiting = await controller.tick('run-1');
  assert.equal(waiting.status, 'WAITING_HUMAN');
  assert.equal(waiting.pending_decision_ids.length, 1);
  const decisionId = waiting.pending_decision_ids[0]!;
  const resumed = await controller.respond('run-1', decisionId, 'retry with the simpler option');
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(resumed.graph.tasks[0]?.status, 'READY');
});
