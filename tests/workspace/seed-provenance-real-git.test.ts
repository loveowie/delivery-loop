import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState, TaskNode } from '../../src/domain/types.js';
import { PatchIntegrator } from '../../src/workspace/patch-integrator.js';
import { createCodeSnapshot } from '../../src/workspace/repository-context.js';
import { WorktreeManager } from '../../src/workspace/worktree-manager.js';
import { createGitFixture, fixtureExecutor } from './git-fixture.js';
import type { GitFixture } from './git-fixture.js';

function task(id: string): TaskNode {
  return {
    id,
    type: 'implementation',
    title: `task ${id}`,
    status: 'READY',
    priority: 'normal',
    risk: 'low',
    origin: 'initial_plan',
    depends_on: [],
    requirement_ids: [],
    acceptance_ids: [],
    scope_paths: ['src'],
    required_outputs: [],
    worker_role: 'implementer',
    capability_profile: 'portable',
    attempt: 0,
    max_attempts: 3,
    verification_commands: [],
    review_policy: 'none',
  };
}

function runState(repo: string, baseline: string): RunState {
  return {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'RUNNING',
    repo_root: repo,
    baseline_commit: baseline,
    created_at: '2026-11-17T00:00:00Z',
    updated_at: '2026-11-17T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-1', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
}

function managerFor(fixture: GitFixture): { manager: WorktreeManager; patches: PatchIntegrator } {
  const executor = fixtureExecutor(fixture);
  const patches = new PatchIntegrator(executor);
  return {
    manager: new WorktreeManager(fixture.path, executor, patches),
    patches,
  };
}

test('accepted seed export fails closed when the integration worktree lost its .git entry', async () => {
  const fixture = await createGitFixture();
  try {
    const { manager } = managerFor(fixture);
    const state = runState(fixture.path, fixture.baseline);
    const integration = await manager.ensureIntegration(state);
    await writeFile(join(integration, 'src', 'tracked.txt'), 'accepted change\n');
    state.integration_worktree = integration;
    state.integration_snapshot_id = 'SNAP-accepted';

    // Without its own .git entry git discovery walks up into the outer
    // repository and would export an empty patch while reporting success.
    await rm(join(integration, '.git'), { force: true });

    await assert.rejects(
      manager.prepare(state, task('TASK-AFTER-SEED')),
      /managed worktree|\.git|missing|invalid/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('an accepted snapshot that lost its content exports an empty seed patch and fails closed', async () => {
  const fixture = await createGitFixture();
  try {
    const { manager } = managerFor(fixture);
    const state = runState(fixture.path, fixture.baseline);
    const integration = await manager.ensureIntegration(state);
    // The accepted snapshot id is not the baseline snapshot, but the worktree
    // is at baseline content: the export is empty although content was accepted.
    state.integration_worktree = integration;
    state.integration_snapshot_id = 'SNAP-accepted';

    await assert.rejects(
      manager.prepare(state, task('TASK-EMPTY-SEED')),
      /empty/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('a no-op accepted integration legitimately exports an empty seed patch', async () => {
  const fixture = await createGitFixture();
  try {
    const { manager } = managerFor(fixture);
    const state = runState(fixture.path, fixture.baseline);
    const integration = await manager.ensureIntegration(state);
    state.integration_worktree = integration;
    state.integration_snapshot_id = (await createCodeSnapshot(integration)).id;

    const workspace = await manager.prepare(state, task('TASK-NOOP-SEED'));

    assert.equal(
      await readFile(join(workspace.path, 'src', 'tracked.txt'), 'utf8'),
      'baseline\n',
    );
    await workspace.cleanup();
  } finally {
    await fixture.cleanup();
  }
});

test('a tampered seed patch is rejected before it is applied', async () => {
  const fixture = await createGitFixture();
  const patchDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-seed-digest-'));
  try {
    const { manager, patches } = managerFor(fixture);
    const state = runState(fixture.path, fixture.baseline);
    const integration = await manager.ensureIntegration(state);
    await writeFile(join(integration, 'src', 'tracked.txt'), 'first change\n');
    const first = await patches.exportTaskPatch(
      integration,
      fixture.baseline,
      patchDirectory,
      [],
      { run_id: state.run_id },
    );
    const target = join(fixture.path, '.delivery', 'runs', 'seed-digest-target');
    await fixture.git(['worktree', 'add', '--detach', target, fixture.baseline]);

    const applied = await patches.applyToIntegration(
      target,
      first.path,
      { run_id: state.run_id },
      { expectedSha256: first.sha256 },
    );
    assert.deepEqual(applied, { ok: true });
    assert.equal(await readFile(join(target, 'src', 'tracked.txt'), 'utf8'), 'first change\n');

    await writeFile(join(integration, 'src', 'tracked.txt'), 'second change\n');
    const second = await patches.exportTaskPatch(
      integration,
      fixture.baseline,
      patchDirectory,
      [],
      { run_id: state.run_id },
    );
    // The run directory is Worker-writable; tamper between export and apply.
    await writeFile(second.path, `${await readFile(second.path, 'utf8')}\n--- tampered\n`, 'utf8');

    const rejected = await patches.applyToIntegration(
      target,
      second.path,
      { run_id: state.run_id },
      { expectedSha256: second.sha256 },
    );

    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? '', /digest/i);
    assert.equal(await readFile(join(target, 'src', 'tracked.txt'), 'utf8'), 'first change\n');
  } finally {
    await rm(patchDirectory, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test('the seed application receives the exported patch digest', async () => {
  const fixture = await createGitFixture();
  try {
    const executor = fixtureExecutor(fixture);
    const state = runState(fixture.path, fixture.baseline);
    const integration = await (
      new WorktreeManager(fixture.path, executor).ensureIntegration(state)
    );
    await writeFile(join(integration, 'src', 'tracked.txt'), 'accepted\n');
    state.integration_worktree = integration;
    state.integration_snapshot_id = 'SNAP-accepted';
    const seedPatch = join(fixture.path, '.delivery', 'runs', 'run-1', 'seed.patch');
    await writeFile(seedPatch, 'diff --git a/x b/x\n');
    let captured: { expectedSha256?: string } | undefined;
    const manager = new WorktreeManager(fixture.path, executor, {
      async exportTaskPatch() {
        return { path: seedPatch, sha256: 'declared-seed-digest' };
      },
      async exportDeltaPatch() {
        return { path: seedPatch, sha256: 'declared-seed-digest' };
      },
      async applyToIntegration(_worktree, _patchPath, _approval, options) {
        captured = options;
        return { ok: true };
      },
    });

    await manager.prepare(state, task('TASK-WIRED'));

    assert.equal(captured?.expectedSha256, 'declared-seed-digest');
  } finally {
    await fixture.cleanup();
  }
});
