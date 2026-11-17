import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../../src/state/state-store.js';
import type { DeliveryConfig, RunState, TaskGraph, TaskNode } from '../../src/domain/types.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';

function runState(runId: string): RunState {
  const graph: TaskGraph = { run_id: runId, tasks: [] };
  return {
    state_schema_version: 1,
    run_id: runId,
    status: 'DRAFT',
    repo_root: '/tmp/repo',
    created_at: '2026-10-28T00:00:00.000Z',
    updated_at: '2026-10-28T00:00:00.000Z',
    config: structuredClone(DEFAULT_CONFIG as DeliveryConfig),
    graph,
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
}

test('reloads the latest atomically written run state', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-state-'));
  const store = await StateStore.open(repo);
  const created = await store.createRun(runState('run-1'));

  await store.updateRun(created.run_id, (state) => ({ ...state, status: 'RUNNING' }));

  const loaded = await store.readRun('run-1');
  assert.equal(loaded?.status, 'RUNNING');
  assert.equal(loaded?.state_schema_version, 1);
});

test('appends immutable JSONL events', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-state-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState('run-1'));

  await store.appendEvent('run-1', { type: 'run_created', run_id: 'run-1' });
  await store.appendEvent('run-1', { type: 'run_resumed', run_id: 'run-1' });

  const path = join(repo, '.delivery', 'runs', 'run-1', 'events.jsonl');
  const lines = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(lines.map((line) => line.type), ['run_created', 'run_resumed']);
});

test('refuses to overwrite an existing run id', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-state-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState('run-1'));

  await assert.rejects(store.createRun(runState('run-1')), /already exists/i);
});

test('serializes concurrent state updates from different process-like callers', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-state-'));
  const first = await StateStore.open(repo);
  const second = await StateStore.open(repo);
  await first.createRun(runState('run-1'));

  // Both callbacks must be order-independent: whichever update acquires the
  // state lock first, the other appends its task to the result. Replacing the
  // array (and reading tasks[0] before appending) made this test randomly fail
  // depending on lock acquisition order.
  const baseTask: TaskNode = {
    id: 'A',
    type: 'implementation',
    title: 'A',
    status: 'READY',
    priority: 'normal',
    risk: 'low',
    origin: 'initial_plan',
    depends_on: [],
    requirement_ids: [],
    acceptance_ids: [],
    scope_paths: ['src/a'],
    required_outputs: ['code'],
    worker_role: 'implementer',
    capability_profile: 'portable',
    attempt: 0,
    max_attempts: 3,
    verification_commands: [],
    review_policy: 'none',
  };
  const taskA: TaskNode = { ...baseTask, id: 'A' };
  const taskB: TaskNode = { ...baseTask, id: 'B' };

  await Promise.all([
    first.updateRun('run-1', (state) => ({
      ...state,
      graph: { ...state.graph, tasks: [...state.graph.tasks, taskA] },
    })),
    second.updateRun('run-1', (state) => ({
      ...state,
      graph: { ...state.graph, tasks: [...state.graph.tasks, taskB] },
    })),
  ]);

  const loaded = await first.readRun('run-1');
  assert.deepEqual(loaded?.graph.tasks.map((task) => task.id).sort(), ['A', 'B']);
});

test('rejects a symlinked delivery runtime directory', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-state-'));
  const outside = await mkdtemp(join(tmpdir(), 'delivery-loop-outside-'));
  await symlink(outside, join(repo, '.delivery'));

  await assert.rejects(StateStore.open(repo), /symlink/i);
});

test('rejects symlinked run parents and artifact subdirectories',async()=>{
  const {mkdir}=await import('node:fs/promises');
  const repo=await mkdtemp(join(tmpdir(),'delivery-path-'));const outside=await mkdtemp(join(tmpdir(),'delivery-outside-'));const store=await StateStore.open(repo);
  await symlink(outside,join(repo,'.delivery','runs','escape'));
  await assert.rejects(store.createRun(runState('escape')),/symlink/i);
  await store.createRun(runState('safe'));await symlink(outside,join(store.getRunDirectory('safe'),'artifacts'));
  await assert.rejects(store.writeArtifact('safe','artifacts/escape.txt','escaped'),/symlink/i);
});

test('run revisions are monotonic and stale expected updates are rejected',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'delivery-revision-'));const store=await StateStore.open(repo);const created=await store.createRun(runState('run'));
  assert.equal(created.revision,0);const next=await store.updateRun('run',state=>state,{expectedRevision:0});assert.equal(next.revision,1);
  await assert.rejects(store.updateRun('run',state=>state,{expectedRevision:0}),/revision conflict/i);
});

test('corrupt persisted runtime structures are rejected on read',async()=>{
  const {writeFile}=await import('node:fs/promises');const repo=await mkdtemp(join(tmpdir(),'delivery-corrupt-'));const store=await StateStore.open(repo);await store.createRun(runState('run'));
  await writeFile(join(store.getRunDirectory('run'),'run.json'),JSON.stringify({state_schema_version:1,run_id:'run',graph:{run_id:'run',tasks:[]}}));
  await assert.rejects(store.readRun('run'),/invalid|config|status/i);
});
