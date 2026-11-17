import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeFactory } from '../../src/runtime/runtime-factory.js';
import { StateStore } from '../../src/state/state-store.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState } from '../../src/domain/types.js';

test('runtime factory preflights skills and constructs a delivery controller', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-runtime-'));
  const store = await StateStore.open(repo);
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'PLANNING',
    repo_root: repo,
    baseline_commit: 'abc',
    created_at: '2026-10-28T00:00:00Z',
    updated_at: '2026-10-28T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-1', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
  await store.createRun(state);
  const factory = new RuntimeFactory({
    pluginRoot: process.cwd(),
    gitExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    workerAdapter: {
      async run() {
        throw new Error('worker is not invoked during construction');
      },
    },
  });

  const runtime = await factory.create(repo, 'run-1');

  assert.ok(runtime.controller);
  assert.ok(runtime.skillResolver);
  assert.ok(runtime.evidenceLedger);
});

test('reopened runtime uses frozen role assignments after installed profile changes', async () => {
  const { cp, readFile, writeFile } = await import('node:fs/promises');
  const repo=await mkdtemp(join(tmpdir(),'delivery-runtime-frozen-'));const plugin=await mkdtemp(join(tmpdir(),'delivery-plugin-frozen-'));
  await cp(join(process.cwd(),'capabilities'),join(plugin,'capabilities'),{recursive:true});
  const store=await StateStore.open(repo);await store.createRun({state_schema_version:1,run_id:'run',status:'PLANNING',repo_root:repo,created_at:'now',updated_at:'now',config:structuredClone(DEFAULT_CONFIG),graph:{run_id:'run',tasks:[]},current_task_ids:[],pause_requested:false,pending_decision_ids:[]});
  const factory=new RuntimeFactory({pluginRoot:plugin,gitExecutor:async()=>({stdout:'',stderr:'',exitCode:0}),workerAdapter:{async run(){throw Error('unused');}}});
  const first=await factory.create(repo,'run');const before=await first.skillResolver.resolve('portable','implementer',[]);
  assert.ok(before.length>0);
  const rolesPath=join(plugin,'capabilities','role-skills.yaml');await writeFile(rolesPath,'roles:\n  implementer:\n    skills: []\n');
  const reopened=await factory.create(repo,'run');const after=await reopened.skillResolver.resolve('portable','implementer',[]);
  assert.deepEqual(after,before);assert.match(await readFile(join(store.getRunDirectory('run'),'runtime-bundle.json'),'utf8'),/role_assignments/);
});

test('reopened runtime uses only the frozen skill tree when installed capabilities are removed', async () => {
  const { cp, rm } = await import('node:fs/promises');
  const repo = await mkdtemp(join(tmpdir(), 'delivery-runtime-frozen-install-'));
  const plugin = await mkdtemp(join(tmpdir(), 'delivery-plugin-frozen-install-'));
  await cp(join(process.cwd(), 'capabilities'), join(plugin, 'capabilities'), { recursive: true });
  const store = await StateStore.open(repo);
  await store.createRun({
    state_schema_version: 1,
    run_id: 'run',
    status: 'PLANNING',
    repo_root: repo,
    created_at: 'now',
    updated_at: 'now',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  });
  const options = {
    pluginRoot: plugin,
    gitExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    workerAdapter: { async run() { throw Error('unused'); } },
  };
  await new RuntimeFactory(options).create(repo, 'run');
  await rm(join(plugin, 'capabilities'), { recursive: true, force: true });

  const reopened = await new RuntimeFactory(options).create(repo, 'run');
  const skills = await reopened.skillResolver.resolve('portable', 'implementer', []);

  assert.ok(skills.length > 0);
});

test('reopened runtime rejects a tampered frozen skill tree', async () => {
  const { cp, readFile, writeFile } = await import('node:fs/promises');
  const repo = await mkdtemp(join(tmpdir(), 'delivery-runtime-frozen-tamper-'));
  const plugin = await mkdtemp(join(tmpdir(), 'delivery-plugin-frozen-tamper-'));
  await cp(join(process.cwd(), 'capabilities'), join(plugin, 'capabilities'), { recursive: true });
  const store = await StateStore.open(repo);
  await store.createRun({
    state_schema_version: 1,
    run_id: 'run',
    status: 'PLANNING',
    repo_root: repo,
    created_at: 'now',
    updated_at: 'now',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  });
  const options = {
    pluginRoot: plugin,
    gitExecutor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    workerAdapter: { async run() { throw Error('unused'); } },
  };
  await new RuntimeFactory(options).create(repo, 'run');
  const bundle = JSON.parse(await readFile(join(store.getRunDirectory('run'), 'runtime-bundle.json'), 'utf8')) as {
    skills: Array<{ root: string }>;
  };
  await writeFile(join(bundle.skills[0]!.root, 'SKILL.md'), '# tampered\n');

  await assert.rejects(
    new RuntimeFactory(options).create(repo, 'run'),
    /skill hash mismatch|skill tree hash mismatch/i,
  );
});
