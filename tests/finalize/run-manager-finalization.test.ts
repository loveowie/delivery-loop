import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState } from '../../src/domain/types.js';
import { finalizeRun } from '../../src/finalize/finalizer.js';
import { DeliveryRunManager } from '../../src/runtime/run-manager.js';
import { StateStore } from '../../src/state/state-store.js';
import { PatchIntegrator } from '../../src/workspace/patch-integrator.js';
import { createCodeSnapshot } from '../../src/workspace/repository-context.js';
import { WorktreeManager } from '../../src/workspace/worktree-manager.js';
import { createGitFixture, fixtureExecutor } from '../workspace/git-fixture.js';

async function finalizationFixture() {
  const fixture = await createGitFixture();
  const executor = fixtureExecutor(fixture);
  const worktrees = new WorktreeManager(fixture.path, executor, new PatchIntegrator(executor));
  const store = await StateStore.open(fixture.path);
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'COMPLETED',
    repo_root: fixture.path,
    baseline_commit: fixture.baseline,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-1', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
  const integration = await worktrees.ensureIntegration(state);
  await writeFile(join(integration, 'src', 'tracked.txt'), 'final content\n');
  const snapshot = await createCodeSnapshot(integration);
  const persisted: RunState = {
    ...state,
    integration_worktree: integration,
    integration_snapshot_id: snapshot.id,
  };
  await store.createRun(persisted);
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    runtimeFactory: {} as never,
  });
  return { fixture, manager, store, integration, state: persisted };
}

test('commit recovery recognizes the run-owned commit after result persistence fails', async () => {
  const f = await finalizationFixture();
  try {
    await assert.rejects(
      finalizeRun(
        f.store,
        'run-1',
        { mode: 'commit', confirmation: 'run-1:commit' },
        async (action, state, context) => {
          await f.manager.executeFinalize(action, state, context);
          throw new Error('crash after git commit');
        },
      ),
      /crash after git commit/,
    );
    const committedHead = (await f.fixture.git(['rev-parse', 'HEAD'], f.integration)).stdout.trim();

    await finalizeRun(
      f.store,
      'run-1',
      { mode: 'commit', confirmation: 'run-1:commit' },
      async (action, state, context) => await f.manager.executeFinalize(action, state, context),
    );

    assert.equal(
      (await f.fixture.git(['rev-parse', 'HEAD'], f.integration)).stdout.trim(),
      committedHead,
    );
    assert.equal(
      (await f.fixture.git(['log', '-1', '--format=%s'], f.integration)).stdout.trim(),
      'delivery: complete run-1',
    );
  } finally {
    await f.fixture.cleanup();
  }
});

test('branch finalization rejects a conflicting pre-existing branch', async () => {
  const f = await finalizationFixture();
  try {
    await f.fixture.git(['branch', 'delivery/run-1']);

    await assert.rejects(
      finalizeRun(
        f.store,
        'run-1',
        { mode: 'branch', confirmation: 'run-1:branch' },
        async (action, state, context) => await f.manager.executeFinalize(action, state, context),
      ),
      /branch already exists/i,
    );
  } finally {
    await f.fixture.cleanup();
  }
});

test('push recovery accepts the exact remote ref written before result persistence failed', async () => {
  const f = await finalizationFixture();
  const remote = await mkdtemp(join(tmpdir(), 'delivery-loop-remote-'));
  try {
    await f.fixture.git(['init', '--bare', remote]);
    await f.fixture.git(['remote', 'add', 'origin', remote]);
    await assert.rejects(
      finalizeRun(
        f.store,
        'run-1',
        { mode: 'push', confirmation: 'run-1:push' },
        async (action, state, context) => {
          await f.manager.executeFinalize(action, state, context);
          throw new Error('crash after git push');
        },
      ),
      /crash after git push/,
    );
    const remoteHead = (await f.fixture.git(['ls-remote', remote, 'refs/heads/delivery/run-1'])).stdout
      .trim()
      .split(/\s+/)[0];

    await finalizeRun(
      f.store,
      'run-1',
      { mode: 'push', confirmation: 'run-1:push' },
      async (action, state, context) => await f.manager.executeFinalize(action, state, context),
    );

    assert.equal(
      (await f.fixture.git(['rev-parse', 'HEAD'], f.integration)).stdout.trim(),
      remoteHead,
    );
  } finally {
    await f.fixture.cleanup();
    await rm(remote, { recursive: true, force: true });
  }
});

test('commit finalization parks the detached commit on a durable delivery ref', async () => {
  const f = await finalizationFixture();
  try {
    await finalizeRun(
      f.store,
      'run-1',
      { mode: 'commit', confirmation: 'run-1:commit' },
      async (action, state, context) => await f.manager.executeFinalize(action, state, context),
    );
    const head = (await f.fixture.git(['rev-parse', 'HEAD'], f.integration)).stdout.trim();
    const ref = (await f.fixture.git(['rev-parse', 'refs/delivery/run-1'], f.integration)).stdout.trim();
    assert.equal(ref, head);
  } finally {
    await f.fixture.cleanup();
  }
});

test('commit finalization never runs repository hooks from delivered content', async () => {
  const f = await finalizationFixture();
  try {
    const hooks = join(f.fixture.path, 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o755 });
    await f.fixture.git(['config', 'core.hooksPath', hooks]);
    await finalizeRun(
      f.store,
      'run-1',
      { mode: 'commit', confirmation: 'run-1:commit' },
      async (action, state, context) => await f.manager.executeFinalize(action, state, context),
    );
    await assert.rejects(access(join(f.integration, 'hook-ran')));
    await assert.rejects(access(join(f.fixture.path, 'hook-ran')));
  } finally {
    await f.fixture.cleanup();
  }
});
