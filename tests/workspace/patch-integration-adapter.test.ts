import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchIntegrationAdapter } from '../../src/workspace/patch-integration-adapter.js';
import type { RunState, TaskNode } from '../../src/domain/types.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';

const state: RunState = {
  state_schema_version: 1,
  run_id: 'run-1',
  status: 'RUNNING',
  repo_root: '/repo',
  baseline_commit: 'abc',
  created_at: '2026-10-28T00:00:00Z',
  updated_at: '2026-10-28T00:00:00Z',
  config: structuredClone(DEFAULT_CONFIG),
  graph: { run_id: 'run-1', tasks: [] },
  current_task_ids: [],
  pause_requested: false,
  pending_decision_ids: [],
};

const task: TaskNode = {
  id: 'TASK-1',
  type: 'implementation',
  title: 'task',
  status: 'INTEGRATING',
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
  attempt: 0,
  max_attempts: 3,
  verification_commands: [],
  review_policy: 'none',
};

test('integration adapter applies a task patch and returns a new integration snapshot', async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-integration-'));
  const calls: string[] = [];
  const adapter = new PatchIntegrationAdapter({
    worktrees: {
      async ensureIntegration() { return '/tmp/integration'; },
      async prepare() { return {path:'/tmp/integration',async cleanup(){}}; },
    },
    patchIntegrator: {
      async exportTaskPatch(worktree) {
        calls.push(`export:${worktree}`);
        return { path: join(runDirectory, `patch-${calls.length}.patch`), sha256: 'patch-sha' };
      },
      async exportDeltaPatch(worktree) {
        calls.push(`delta:${worktree}`);
        return { path: join(runDirectory, `patch-${calls.length}.patch`), sha256: 'patch-sha' };
      },
      async applyToIntegration(worktree, patchPath) {
        calls.push(`apply:${worktree}:${patchPath}`);
        return { ok: true };
      },
    },
    snapshots: {
      async create(workdir) {
        return {
          id: 'SNAP-INTEGRATION',
          created_at: '2026-10-28T00:00:00Z',
          baseline_commit: 'abc',
          worktree_digest: workdir,
          untracked_files: [],
        };
      },
    },
    runDirectory,
  });

  const result = await adapter.integrate(
    state,
    task,
    '/tmp/task-worktree',
    {
      id: 'SNAP-TASK',
      created_at: '2026-10-28T00:00:00Z',
      baseline_commit: 'abc',
      worktree_digest: 'task',
      untracked_files: ['src/new.ts'],
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.workdir, '/tmp/integration');
  assert.equal(result.snapshot_id, 'SNAP-INTEGRATION');
  assert.deepEqual(calls.slice(0, 2), [
    'delta:/tmp/task-worktree',
    `apply:/tmp/integration:${join(runDirectory, 'patch-1.patch')}`,
  ]);
  assert.equal(calls.at(-1), 'export:/tmp/integration');
});

test('integration prepares an isolated candidate seeded from accepted content', async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-candidate-'));
  let appliedTo = ''; let seed: string | undefined;
  const candidateState = structuredClone(state); candidateState.integration_worktree = '/tmp/accepted';
  const adapter = new PatchIntegrationAdapter({
    worktrees: {
      async ensureIntegration(){ throw new Error('accepted worktree must not be mutated'); },
      async prepare(_state, _task, accepted){seed=accepted;return {path:'/tmp/candidate',async cleanup(){}};},
    },
    patchIntegrator:{async exportTaskPatch(){return {path:join(runDirectory,'delivery.patch'),sha256:'sha'};},async exportDeltaPatch(){return {path:join(runDirectory,'task.patch'),sha256:'sha'};},async applyToIntegration(path){appliedTo=path;return {ok:true};}},
    snapshots:{async create(){return {id:'S',created_at:'now',baseline_commit:'abc',worktree_digest:'d',untracked_files:[]};}},runDirectory,
  });
  const result=await adapter.integrate(candidateState,task,'/tmp/task',{id:'T',created_at:'now',baseline_commit:'abc',worktree_digest:'d',untracked_files:[]});
  assert.equal(result.workdir,'/tmp/candidate');assert.equal(seed,'/tmp/accepted');assert.equal(appliedTo,'/tmp/candidate');
});

test('replayed integration reuses a matching immutable candidate result',async()=>{
  const runDirectory=await mkdtemp(join(tmpdir(),'delivery-replay-'));let applies=0;
  const adapter=new PatchIntegrationAdapter({worktrees:{async ensureIntegration(){return '/candidate';},async prepare(){return {path:'/candidate',async cleanup(){}};}},patchIntegrator:{async exportTaskPatch(_w,_b,d){const {writeFile}=await import('node:fs/promises');const path=join(d,'delivery.patch');await writeFile(path,'content');const {createHash}=await import('node:crypto');return {path,sha256:createHash('sha256').update('content').digest('hex')};},async exportDeltaPatch(){return {path:'/delta',sha256:'sha'};},async applyToIntegration(){applies++;return applies===1?{ok:true}:{ok:false,error:'already applied'};}},snapshots:{async create(){return {id:'S',created_at:'now',baseline_commit:'abc',worktree_digest:'d',untracked_files:[]};}},runDirectory});
  const snapshot={id:'T',created_at:'now',baseline_commit:'abc',worktree_digest:'d',untracked_files:[]};
  const first=await adapter.integrate(state,task,'/task',snapshot);const replay=await adapter.integrate(state,task,'/task',snapshot);assert.equal(replay.ok,true);assert.deepEqual(replay,first);assert.equal(applies,1);
});
