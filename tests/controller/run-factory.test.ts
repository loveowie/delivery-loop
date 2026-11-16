import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreparedRunFactory } from '../../src/controller/run-factory.js';

test('prepared run factory imports an approved graph and records the repository baseline', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-run-factory-'));
  const prepared = join(repo, '.delivery', 'prepared', 'draft-1');
  await mkdir(prepared, { recursive: true });
  await writeFile(join(prepared, 'spec.md'), '# Approved spec\n');
  await writeFile(
    join(prepared, 'delivery.yaml'),
    ['runtime:', '  max_parallel_workers: 4', '  max_duration_hours: 2'].join('\n'),
  );
  await writeFile(
    join(prepared, 'task-graph.json'),
    JSON.stringify({
      run_id: 'draft',
      requirements: [{ id: 'REQ-1', description: 'works', status: 'PENDING' }],
      acceptance: [],
      tasks: [],
    }),
  );
  const factory = new PreparedRunFactory({
    async inspect() {
      return { canonical_root: repo, baseline_commit: 'abc123' };
    },
  });

  const state = await factory.create({
    repo_root: repo,
    prepared_directory: prepared,
    run_id: 'run-1',
    config_override: { runtime: { max_parallel_workers: 1 } },
  });

  assert.equal(state.run_id, 'run-1');
  assert.equal(state.status, 'PLANNING');
  assert.equal(state.baseline_commit, 'abc123');
  assert.equal(state.graph.run_id, 'run-1');
  assert.equal(state.config.runtime.max_parallel_workers, 1);
  assert.equal(state.config.runtime.max_duration_hours, 2);
  assert.match(await readFile(join(repo, '.delivery', 'runs', 'run-1', 'spec.md'), 'utf8'), /Approved spec/);
});

test('prepared graph cannot import claimed completion or satisfied requirements', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-untrusted-plan-'));
  const prepared=join(repo,'prepared');await mkdir(prepared);await writeFile(join(prepared,'spec.md'),'# Spec');
  await writeFile(join(prepared,'task-graph.json'),JSON.stringify({run_id:'draft',tasks:[],requirements:[{id:'R',description:'unverified',status:'SATISFIED'}]}));
  const factory=new PreparedRunFactory({async inspect(){return {canonical_root:repo,baseline_commit:'base'};}});
  await assert.rejects(factory.create({repo_root:repo,prepared_directory:prepared,run_id:'run'}),/initial|PENDING|completion/i);
});
