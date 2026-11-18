import test from 'node:test';
import assert from 'node:assert/strict';
import { access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState } from '../../src/domain/types.js';
import { DeliveryService } from '../../src/service/delivery-service.js';
import { DeliveryRunManager } from '../../src/runtime/run-manager.js';
import { StateStore } from '../../src/state/state-store.js';
import { PatchIntegrator } from '../../src/workspace/patch-integrator.js';
import { createCodeSnapshot } from '../../src/workspace/repository-context.js';
import { WorktreeManager } from '../../src/workspace/worktree-manager.js';
import { createGitFixture, fixtureExecutor } from '../workspace/git-fixture.js';
import type { GitFixture } from '../workspace/git-fixture.js';

const RUN_ID = 'run-1';
const DELIVERY_CONTENT = 'delivered\n';

function completedState(fixture: GitFixture): RunState {
  return {
    state_schema_version: 1,
    run_id: RUN_ID,
    status: 'COMPLETED',
    repo_root: fixture.path,
    baseline_commit: fixture.baseline,
    created_at: '2026-11-17T00:00:00Z',
    updated_at: '2026-11-17T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: RUN_ID, tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
}

async function seededIntegration(fixture: GitFixture, content = DELIVERY_CONTENT) {
  const executor = fixtureExecutor(fixture);
  const worktrees = new WorktreeManager(fixture.path, executor, new PatchIntegrator(executor));
  const state = completedState(fixture);
  const integration = await worktrees.ensureIntegration(state);
  await writeFile(join(integration, 'src', 'tracked.txt'), content);
  await writeFile(join(integration, 'src', 'added.txt'), 'new file\n');
  const snapshot = await createCodeSnapshot(integration);
  return { integration, snapshot };
}

async function finalizeFixture() {
  const fixture = await createGitFixture();
  const store = await StateStore.open(fixture.path);
  const state = completedState(fixture);
  const seeded = await seededIntegration(fixture);
  const persisted: RunState = {
    ...state,
    integration_worktree: seeded.integration,
    integration_snapshot_id: seeded.snapshot.id,
  };
  await store.createRun(persisted);
  const manager = new DeliveryRunManager({
    pluginRoot: process.cwd(),
    runtimeFactory: {
      async create() {
        return { controller: {} as never, store, evidenceLedger: undefined };
      },
    } as never,
  });
  const service = new DeliveryService(
    manager,
    async (action, validatedState, context) =>
      await manager.executeFinalize(action, validatedState, context),
  );
  return { fixture, store, manager, service, state: persisted, integration: seeded.integration, snapshot: seeded.snapshot };
}

async function foreignIntegration(fixture: GitFixture) {
  const orphan = await createGitFixture();
  const executor = fixtureExecutor(orphan);
  const worktrees = new WorktreeManager(orphan.path, executor, new PatchIntegrator(executor));
  const state = completedState(orphan);
  const integration = await worktrees.ensureIntegration(state);
  await writeFile(join(integration, 'src', 'tracked.txt'), DELIVERY_CONTENT);
  await writeFile(join(integration, 'src', 'added.txt'), 'new file\n');
  const snapshot = await createCodeSnapshot(integration);
  return { orphan, integration, snapshot };
}

function commitInput(repoRoot: string) {
  return {
    run_id: RUN_ID,
    mode: 'commit' as const,
    confirmation: `${RUN_ID}:commit`,
    repo_root: repoRoot,
  };
}

test('finalization commits only inside the validated integration worktree', async () => {
  const f = await finalizeFixture();
  try {
    const result = await f.service.delivery_finalize(commitInput(f.fixture.path));

    assert.equal(result.status, 'commit');
    const head = (await f.fixture.git(['rev-parse', 'HEAD'], f.integration)).stdout.trim();
    const ref = (await f.fixture.git(['rev-parse', 'refs/delivery/run-1'], f.integration)).stdout.trim();
    assert.equal(ref, head);
    assert.equal(
      (await f.fixture.git(['log', '-1', '--format=%s'], f.integration)).stdout.trim(),
      `delivery: complete ${RUN_ID}`,
    );
  } finally {
    await f.fixture.cleanup();
  }
});

test('finalization rejects an integration worktree whose .git entry was removed', async () => {
  const f = await finalizeFixture();
  try {
    await rm(join(f.integration, '.git'), { force: true });

    await assert.rejects(
      f.service.delivery_finalize(commitInput(f.fixture.path)),
      /managed worktree|\.git|missing|invalid/i,
    );

    // The outer repository must not gain the delivery ref.
    assert.equal((await f.fixture.git(['for-each-ref', 'refs/delivery'])).stdout.trim(), '');
  } finally {
    await f.fixture.cleanup();
  }
});

test('finalization rejects an integration worktree that belongs to another repository', async () => {
  const f = await finalizeFixture();
  const foreign = await foreignIntegration(f.fixture);
  try {
    // The content is identical, so only the repository identity can catch the redirection.
    assert.equal(foreign.snapshot.id, f.snapshot.id);
    await f.store.updateRun(RUN_ID, (draft) => ({
      ...draft,
      integration_worktree: foreign.integration,
      integration_snapshot_id: foreign.snapshot.id,
    }));

    await assert.rejects(
      f.service.delivery_finalize(commitInput(f.fixture.path)),
      /different repository|not inside the run directory|managed worktree/i,
    );

    assert.equal((await f.fixture.git(['for-each-ref', 'refs/delivery'])).stdout.trim(), '');
    assert.equal((await foreign.orphan.git(['for-each-ref', 'refs/delivery'])).stdout.trim(), '');
  } finally {
    await f.fixture.cleanup();
    await foreign.orphan.cleanup();
  }
});

test('finalization uses the state re-read under the finalization lock, not the stale handle', async () => {
  const f = await finalizeFixture();
  const foreign = await foreignIntegration(f.fixture);
  try {
    const staleHandle = {
      state: f.state,
      store: f.store,
      repoRoot: f.fixture.path,
      controller: {} as never,
    };
    const manager = new DeliveryRunManager({
      pluginRoot: process.cwd(),
      runtimeFactory: {} as never,
    });
    const service = new DeliveryService(
      {
        async get() {
          return staleHandle;
        },
        async start() {
          throw new Error('not used');
        },
      } as never,
      async (action, validatedState, context) =>
        await manager.executeFinalize(action, validatedState, context),
    );
    // The handle still points at the original worktree; the persisted run was
    // redirected to another repository with identical content.
    await f.store.updateRun(RUN_ID, (draft) => ({
      ...draft,
      integration_worktree: foreign.integration,
    }));

    await assert.rejects(
      service.delivery_finalize(commitInput(f.fixture.path)),
      /different repository|not inside the run directory|managed worktree/i,
    );

    const ownHead = (await f.fixture.git(['rev-parse', 'HEAD'], f.integration)).stdout.trim();
    assert.equal(ownHead, f.fixture.baseline);
  } finally {
    await f.fixture.cleanup();
    await foreign.orphan.cleanup();
  }
});

test('finalization rejects a repo_root that does not own the run and creates no runtime state there', async () => {
  const f = await finalizeFixture();
  const unrelated = await createGitFixture();
  try {
    await assert.rejects(
      f.service.delivery_finalize(commitInput(unrelated.path)),
      /run not found|different repository|repo_root/i,
    );

    // The rejected call must not leave `.delivery` in the unrelated repository.
    await assert.rejects(access(join(unrelated.path, '.delivery')));
    assert.equal((await f.fixture.git(['for-each-ref', 'refs/delivery'])).stdout.trim(), '');
  } finally {
    await f.fixture.cleanup();
    await unrelated.cleanup();
  }
});
