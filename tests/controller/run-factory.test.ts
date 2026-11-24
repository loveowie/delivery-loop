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
      acceptance: [{ id: 'AC-1', requirement_id: 'REQ-1', description: 'human check', verification: { type: 'manual' }, mandatory: true, risk: 'low' }],
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
  await writeFile(join(prepared,'task-graph.json'),JSON.stringify({run_id:'draft',tasks:[],requirements:[{id:'R',description:'unverified',status:'SATISFIED'}],acceptance:[{id:'A',requirement_id:'R',description:'check',verification:{type:'manual'},mandatory:true,risk:'low'}]}));
  const factory=new PreparedRunFactory({async inspect(){return {canonical_root:repo,baseline_commit:'base'};}});
  await assert.rejects(factory.create({repo_root:repo,prepared_directory:prepared,run_id:'run'}),/initial|PENDING|completion/i);
});

test('prepared trusted-host verification requires explicit start acknowledgement', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-trusted-'));
  await mkdir(join(repo, 'prepared'), { recursive: true });
  await writeFile(join(repo, 'prepared', 'spec.md'), '# Spec\n');
  await writeFile(
    join(repo, 'prepared', 'delivery.yaml'),
    ['verification:', '  execution:', '    backend: trusted-host'].join('\n'),
  );
  await writeFile(
    join(repo, 'prepared', 'task-graph.json'),
    JSON.stringify({
      run_id: 'draft',
      requirements: [{ id: 'R', description: 'r', status: 'PENDING' }],
      acceptance: [{ id: 'A', requirement_id: 'R', description: 'check', verification: { type: 'manual' }, mandatory: true, risk: 'low' }],
      tasks: [],
    }),
  );
  const factory = new PreparedRunFactory({
    async inspect() {
      return { canonical_root: repo, baseline_commit: 'abc123' };
    },
  });

  await assert.rejects(
    factory.create({ repo_root: repo, prepared_directory: join(repo, 'prepared'), run_id: 'run-1' }),
    /allow_trusted_host/i,
  );
  const state = await factory.create({
    repo_root: repo,
    prepared_directory: join(repo, 'prepared'),
    run_id: 'run-1',
    allow_trusted_host: true,
  });
  assert.equal(state.config.verification.execution?.backend, 'trusted-host');
});

test('view settings override the prepared runtime block but not an explicit start override', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-run-factory-'));
  const home = await mkdtemp(join(tmpdir(), 'delivery-loop-settings-home-'));
  const prepared = join(repo, '.delivery', 'prepared', 'draft-settings');
  await mkdir(prepared, { recursive: true });
  await writeFile(join(prepared, 'spec.md'), '# Spec\n');
  await writeFile(
    join(prepared, 'delivery.yaml'),
    ['runtime:', '  max_total_tokens: 1000000', '  max_duration_hours: 3'].join('\n'),
  );
  await writeFile(
    join(prepared, 'task-graph.json'),
    JSON.stringify({
      run_id: 'draft',
      requirements: [{ id: 'R', description: 'r', status: 'PENDING' }],
      acceptance: [{ id: 'A', requirement_id: 'R', description: 'check', verification: { type: 'manual' }, mandatory: true, risk: 'low' }],
      tasks: [],
    }),
  );
  const { SettingsStore } = await import('../../src/config/settings.js');
  const settings = new SettingsStore({ home });
  await settings.writeGlobal({ max_total_tokens: 5000000 });
  await settings.writeRepo(repo, { max_duration_hours: 6 });

  const factory = new PreparedRunFactory({
    inspector: {
      async inspect() {
        return { canonical_root: repo, baseline_commit: 'abc123' };
      },
    },
    settings,
  });

  const state = await factory.create({
    repo_root: repo,
    prepared_directory: prepared,
    run_id: 'run-settings',
  });
  assert.equal(state.config.runtime.max_total_tokens, 5_000_000);
  assert.equal(state.config.runtime.max_duration_hours, 6);
  assert.equal(state.config.runtime.default_worker_timeout_seconds, 1800);

  const pinned = await factory.create({
    repo_root: repo,
    prepared_directory: prepared,
    run_id: 'run-pinned',
    config_override: { runtime: { max_total_tokens: 2_000_000 } },
  });
  assert.equal(pinned.config.runtime.max_total_tokens, 2_000_000);
});
