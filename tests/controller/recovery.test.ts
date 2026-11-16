import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverInterruptedRun } from '../../src/controller/recovery.js';
import { StateStore } from '../../src/state/state-store.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState, TaskNode } from '../../src/domain/types.js';

test('recovery moves interrupted tasks to ready and resumes the run', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-recovery-'));
  const task: TaskNode = {
    id: 'TASK-1',
    type: 'implementation',
    title: 'task',
    status: 'INTERRUPTED',
    priority: 'normal',
    risk: 'low',
    origin: 'initial_plan',
    depends_on: [],
    requirement_ids: [],
    acceptance_ids: [],
    scope_paths: ['src'],
    required_outputs: ['code'],
    worker_role: 'implementer',
    capability_profile: 'portable',
    attempt: 1,
    max_attempts: 3,
    verification_commands: [],
    review_policy: 'none',
  };
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'RUNNING',
    repo_root: repo,
    created_at: '2026-10-28T00:00:00Z',
    updated_at: '2026-10-28T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-1', tasks: [task] },
    current_task_ids: ['TASK-1'],
    pause_requested: false,
    pending_decision_ids: [],
  };
  const store = await StateStore.open(repo);
  await store.createRun(state);

  const recovered = await recoverInterruptedRun(store, 'run-1');

  assert.equal(recovered.graph.tasks[0]?.status, 'READY');
  assert.deepEqual(recovered.current_task_ids, []);
});

test('recovery adopts a stale running task after the worker lock is recovered', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-recovery-'));
  const task: TaskNode = {
    id: 'TASK-1', type: 'implementation', title: 'task', status: 'RUNNING',
    priority: 'normal', risk: 'low', origin: 'initial_plan', depends_on: [],
    requirement_ids: [], acceptance_ids: [], scope_paths: ['src'], required_outputs: ['code'],
    worker_role: 'implementer', capability_profile: 'portable', attempt: 1, max_attempts: 3,
    verification_commands: [], review_policy: 'none',
  };
  const state: RunState = {
    state_schema_version: 1, run_id: 'run-1', status: 'RUNNING', repo_root: repo,
    created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG), graph: { run_id: 'run-1', tasks: [task] },
    current_task_ids: ['TASK-1'], pause_requested: false, pending_decision_ids: [],
  };
  const store = await StateStore.open(repo);
  await store.createRun(state);

  const recovered = await recoverInterruptedRun(store, 'run-1');

  assert.equal(recovered.graph.tasks[0]?.status, 'READY');
});

test('recovery also adopts a task interrupted while verifying', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-recovery-'));
  const task: TaskNode = {
    id: 'TASK-1', type: 'implementation', title: 'task', status: 'VERIFYING',
    priority: 'normal', risk: 'low', origin: 'initial_plan', depends_on: [],
    requirement_ids: [], acceptance_ids: [], scope_paths: ['src'], required_outputs: ['code'],
    worker_role: 'implementer', capability_profile: 'portable', attempt: 1, max_attempts: 3,
    verification_commands: [], review_policy: 'none',
  };
  const state: RunState = {
    state_schema_version: 1, run_id: 'run-1', status: 'VERIFYING', repo_root: repo,
    created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG), graph: { run_id: 'run-1', tasks: [task] },
    current_task_ids: ['TASK-1'], pause_requested: false, pending_decision_ids: [],
  };
  const store = await StateStore.open(repo);
  await store.createRun(state);

  const recovered = await recoverInterruptedRun(store, 'run-1');

  assert.equal(recovered.graph.tasks[0]?.status, 'READY');
});

test('recovery preserves tasks waiting for unresolved decisions',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'delivery-recovery-decisions-'));const store=await StateStore.open(repo);
  const state:RunState={state_schema_version:1,run_id:'run',status:'WAITING_HUMAN',repo_root:repo,created_at:'now',updated_at:'now',config:structuredClone(DEFAULT_CONFIG),graph:{run_id:'run',tasks:[{id:'T',type:'implementation',title:'T',status:'INTERRUPTED',priority:'normal',risk:'low',origin:'initial_plan',depends_on:[],requirement_ids:[],acceptance_ids:[],scope_paths:[],required_outputs:[],worker_role:'implementer',capability_profile:'portable',attempt:0,max_attempts:3,verification_commands:[],review_policy:'none'}]},current_task_ids:[],pause_requested:false,pending_decision_ids:['D'],pending_decision_tasks:{D:['T']}};
  await store.createRun(state);assert.equal((await recoverInterruptedRun(store,'run')).graph.tasks[0]?.status,'INTERRUPTED');
});
