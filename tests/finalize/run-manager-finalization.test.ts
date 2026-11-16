import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState } from '../../src/domain/types.js';
import { finalizeRun } from '../../src/finalize/finalizer.js';
import { DeliveryRunManager } from '../../src/runtime/run-manager.js';
import { StateStore } from '../../src/state/state-store.js';
import { createCodeSnapshot } from '../../src/workspace/repository-context.js';
import { createGitFixture } from '../workspace/git-fixture.js';

async function finalizationFixture() {
  const fixture = await createGitFixture();
  await fixture.write('src/tracked.txt', 'final content\n');
  const snapshot = await createCodeSnapshot(fixture.path);
  const store = await StateStore.open(fixture.path);
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'COMPLETED',
    repo_root: fixture.path,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-1', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
    integration_snapshot_id: snapshot.id,
    integration_worktree: fixture.path,
  };
  await store.createRun(state);
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    runtimeFactory: {} as never,
  });
  const handle = { state, store, repoRoot: fixture.path, controller: {} as never };
  return { fixture, manager, handle, store };
}

test('commit recovery recognizes the run-owned commit after result persistence fails', async () => {
  const f = await finalizationFixture();
  try {
    await assert.rejects(
      finalizeRun(
        f.store,
        'run-1',
        { mode: 'commit', confirmation: 'run-1' },
        async (action, _state, context) => {
          await f.manager.executeFinalize(action, f.handle, context);
          throw new Error('crash after git commit');
        },
      ),
      /crash after git commit/,
    );
    const committedHead = (await f.fixture.git(['rev-parse', 'HEAD'])).stdout.trim();

    await finalizeRun(
      f.store,
      'run-1',
      { mode: 'commit', confirmation: 'run-1' },
      async (action, _state, context) => await f.manager.executeFinalize(action, f.handle, context),
    );

    assert.equal((await f.fixture.git(['rev-parse', 'HEAD'])).stdout.trim(), committedHead);
    assert.equal(
      (await f.fixture.git(['log', '-1', '--format=%s'])).stdout.trim(),
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
        { mode: 'branch', confirmation: 'run-1' },
        async (action, _state, context) => await f.manager.executeFinalize(action, f.handle, context),
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
        { mode: 'push', confirmation: 'run-1' },
        async (action, _state, context) => {
          await f.manager.executeFinalize(action, f.handle, context);
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
      { mode: 'push', confirmation: 'run-1' },
      async (action, _state, context) => await f.manager.executeFinalize(action, f.handle, context),
    );

    assert.equal(
      (await f.fixture.git(['rev-parse', 'HEAD'])).stdout.trim(),
      remoteHead,
    );
  } finally {
    await f.fixture.cleanup();
    await rm(remote, { recursive: true, force: true });
  }
});
