import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/config.js';

test('portable config defaults to native provider and no external project skills', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-config-'));

  const config = await loadConfig(repo);

  assert.equal(config.profile, 'portable');
  assert.equal(config.spec.provider, 'native');
  assert.deepEqual(config.capabilities.project_skills, []);
  assert.equal(config.runtime.max_parallel_workers, 2);
  assert.equal(config.git.mode, 'prepare-only');
});

test('repository config and run override are merged over portable defaults', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-config-'));
  await writeFile(
    join(repo, 'delivery.yaml'),
    [
      'profile: openspec',
      'spec:',
      '  provider: openspec',
      '  minimum_cli_version: 1.7.0',
      'runtime:',
      '  max_parallel_workers: 3',
    ].join('\n'),
  );

  const config = await loadConfig(repo, {
    runtime: { max_parallel_workers: 1 },
  });

  assert.equal(config.profile, 'openspec');
  assert.equal(config.spec.provider, 'openspec');
  assert.equal(config.spec.minimum_cli_version, '1.7.0');
  assert.equal(config.runtime.max_parallel_workers, 1);
  assert.equal(config.runtime.default_worker_timeout_seconds, 1800);
});

test('openspec profile without the openspec provider is rejected', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-config-'));

  await assert.rejects(
    loadConfig(repo, { profile: 'openspec' }),
    /openspec profile requires/i,
  );
});

test('unsupported execution policies are rejected rather than silently ignored',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'delivery-policy-'));
  await assert.rejects(loadConfig(repo,{git:{worktree_isolation:false}}),/worktree_isolation/i);
  await assert.rejects(loadConfig(repo,{review:{task_review_policy:'batch'}}),/batch/i);
  await assert.rejects(loadConfig(repo,{spec:{provider:'custom'}}),/custom/i);
});

test('repository config cannot opt into trusted-host verification by itself', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-config-'));
  await writeFile(
    join(repo, 'delivery.yaml'),
    ['verification:', '  execution:', '    backend: trusted-host'].join('\n'),
  );

  await assert.rejects(loadConfig(repo), /cannot enable trusted-host/i);
  const explicit = await loadConfig(repo, {
    verification: { execution: { backend: 'trusted-host' } },
  });
  assert.equal(explicit.verification.execution?.backend, 'trusted-host');
});
