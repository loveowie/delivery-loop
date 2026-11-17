import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../../src/workspace/worktree-manager.js';
import type { RunState, TaskNode } from '../../src/domain/types.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { createGitFixture, fixtureExecutor } from './git-fixture.js';
import { PatchIntegrator } from '../../src/workspace/patch-integrator.js';

function task(): TaskNode {
  return {
    id: 'TASK-1',
    type: 'implementation',
    title: 'task',
    status: 'READY',
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
}

function state(repo: string): RunState {
  return {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'RUNNING',
    repo_root: repo,
    baseline_commit: 'abc123',
    created_at: '2026-10-28T00:00:00Z',
    updated_at: '2026-10-28T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-1', tasks: [task()] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
}

test('worktree manager creates a detached task worktree with run approval', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-worktree-'));
  const commands: Array<{ args: string[]; approval?: { run_id: string } }> = [];
  const manager = new WorktreeManager(repo, {
    async exec(args, _cwd, approval) {
      commands.push({ args, ...(approval === undefined ? {} : { approval }) });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  const workspace = await manager.prepare(state(repo), task());

  assert.match(workspace.path, /\.delivery\/runs\/run-1\/worktrees\/TASK-1-attempt-0$/);
  assert.deepEqual(commands[0]?.args.slice(0, 5), ['worktree', 'add', '--detach', workspace.path, 'abc123']);
  assert.deepEqual(commands[0]?.approval, { run_id: 'run-1' });
});

test('worktree cleanup removes the task worktree with run approval', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-worktree-'));
  const commands: string[][] = [];
  const manager = new WorktreeManager(repo, {
    async exec(args) {
      commands.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const workspace = await manager.prepare(state(repo), task());

  await workspace.cleanup();

  assert.deepEqual(commands.at(-1)?.slice(0, 3), ['worktree', 'remove', '--force']);
});

test('new worktrees are seeded from integrated changes', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-worktree-'));
  const calls: string[] = [];
  const manager = new WorktreeManager(
    repo,
    {
      async exec(args) {
        if (args[0] === 'status') {
          return { stdout: '?? src/new.ts\0', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    {
      async exportTaskPatch(worktree, baseline, outputDirectory, untrackedFiles) {
        calls.push(`export:${worktree}:${baseline}:${untrackedFiles.join(',')}`);
        return { path: join(outputDirectory, 'seed.patch'), sha256: 'seed' };
      },
      async exportDeltaPatch(worktree, outputDirectory, untrackedFiles) {
        calls.push(`delta:${worktree}:${untrackedFiles.join(',')}`);
        return { path: join(outputDirectory, 'delta.patch'), sha256: 'delta' };
      },
      async applyToIntegration(worktree, patchPath) {
        calls.push(`apply:${worktree}:${patchPath}`);
        return { ok: true };
      },
    },
  );

  const workspace = await manager.prepare(state(repo), task(), '/tmp/integration');

  assert.ok(calls.some((call) => call.startsWith('delta:/tmp/integration:src/new.ts')));
  assert.ok(calls.some((call) => call.startsWith(`apply:${workspace.path}`)));
});

test('prepare reuses and validates an existing managed worktree after restart', async () => {
  const repo = await createGitFixture();
  try {
    const runState = state(repo.path);
    runState.baseline_commit = repo.baseline;
    const executor = fixtureExecutor(repo);
    const firstManager = new WorktreeManager(repo.path, executor);
    const first = await firstManager.prepare(runState, task());
    const secondManager = new WorktreeManager(repo.path, executor);

    const recovered = await secondManager.prepare(runState, task());

    assert.equal(recovered.path, first.path);
    assert.equal((await repo.git(['worktree', 'list', '--porcelain'])).stdout.match(/worktree /g)?.length, 2);
    await recovered.cleanup();
  } finally {
    await repo.cleanup();
  }
});

test('task delta includes edits staged after the managed seed was frozen', async () => {
  const repo = await createGitFixture();
  try {
    const runState = state(repo.path);
    runState.baseline_commit = repo.baseline;
    const executor = fixtureExecutor(repo);
    const patches = new PatchIntegrator(executor);
    const manager = new WorktreeManager(repo.path, executor, patches);
    const source = await manager.prepare(runState, task());

    await writeFile(join(source.path, 'src', 'tracked.txt'), 'worker staged content\n');
    await writeFile(join(source.path, 'src', 'worker-new.txt'), 'worker staged new file\n');
    await repo.git(['add', '--', 'src/tracked.txt', 'src/worker-new.txt'], source.path);

    const patchDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-staged-delta-'));
    const delta = await patches.exportDeltaPatch(
      source.path,
      patchDirectory,
      [],
      { run_id: runState.run_id },
    );
    const targetTask = task();
    targetTask.id = 'TARGET';
    const target = await manager.prepare(runState, targetTask);
    assert.deepEqual(
      await patches.applyToIntegration(target.path, delta.path, { run_id: runState.run_id }),
      { ok: true },
    );
    assert.equal(
      await readFile(join(target.path, 'src', 'tracked.txt'), 'utf8'),
      'worker staged content\n',
    );
    assert.equal(
      await readFile(join(target.path, 'src', 'worker-new.txt'), 'utf8'),
      'worker staged new file\n',
    );

    await target.cleanup();
    await source.cleanup();
  } finally {
    await repo.cleanup();
  }
});

test('repair worktree stages the accepted seed and overlays the failed attempt unstaged', async () => {
  const repo = await createGitFixture();
  try {
    const runState = state(repo.path);
    runState.baseline_commit = repo.baseline;
    const executor = fixtureExecutor(repo);
    const patches = new PatchIntegrator(executor);
    const manager = new WorktreeManager(repo.path, executor, patches);
    const integration = await manager.ensureIntegration(runState);
    await repo.write('.delivery/runs/run-1/keep.txt', 'runtime metadata\n');
    await import('node:fs/promises').then(async ({ writeFile }) => {
      await writeFile(join(integration, 'src', 'tracked.txt'), 'accepted\n');
      await writeFile(join(integration, 'src', 'accepted.txt'), 'accepted new\n');
    });
    runState.integration_worktree = integration;

    const failedTask = task();
    const failed = await manager.prepare(runState, failedTask, integration);
    await import('node:fs/promises').then(async ({ writeFile }) => {
      await writeFile(join(failed.path, 'src', 'tracked.txt'), 'failed implementation\n');
      await writeFile(join(failed.path, 'src', 'failed-only.txt'), 'failed but retained\n');
    });

    const repairTask = task();
    repairTask.id = 'FIX-TASK-1';
    repairTask.seed_worktree = failed.path;
    const repair = await manager.prepare(runState, repairTask, failed.path);

    const staged = (await repo.git(['diff', '--cached', '--name-only', '-z'], repair.path)).stdout
      .split('\0')
      .filter(Boolean)
      .sort();
    const unstaged = (await repo.git(['diff', '--name-only', '-z'], repair.path)).stdout
      .split('\0')
      .filter(Boolean)
      .sort();
    assert.deepEqual(staged, ['src/accepted.txt', 'src/tracked.txt']);
    assert.deepEqual(unstaged, ['src/tracked.txt']);
    assert.equal(await readFile(join(repair.path, 'src', 'failed-only.txt'), 'utf8'), 'failed but retained\n');

    await writeFile(join(repair.path, 'src', 'tracked.txt'), 'repaired\n');
    const patchDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-repair-patch-'));
    const repairPatch = await patches.exportDeltaPatch(
      repair.path,
      patchDirectory,
      ['src/failed-only.txt'],
      { run_id: runState.run_id },
    );
    const targetTask = task();
    targetTask.attempt = 2;
    const target = await manager.prepare(runState, targetTask, integration);
    assert.deepEqual(
      await patches.applyToIntegration(target.path, repairPatch.path, { run_id: runState.run_id }),
      { ok: true },
    );
    assert.equal(await readFile(join(target.path, 'src', 'tracked.txt'), 'utf8'), 'repaired\n');
    assert.equal(
      await readFile(join(target.path, 'src', 'failed-only.txt'), 'utf8'),
      'failed but retained\n',
    );

    await target.cleanup();
    await repair.cleanup();
    await failed.cleanup();
  } finally {
    await repo.cleanup();
  }
});

test('managed worktree validation rejects a redirected or missing .git entry', async () => {
  const fixture = await createGitFixture();
  try {
    const workdir = join(fixture.path, '.delivery', 'runs', 'run-1', 'worktrees', 'TASK-1-attempt-0');
    await fixture.git(['worktree', 'add', '--detach', workdir, fixture.baseline]);
    const { assertManagedWorktree } = await import('../../src/workspace/worktree-manager.js');
    const { GuardedGitAdapter, createNodeGitExecutor } = await import('../../src/workspace/git-adapter.js');
    const git = new GuardedGitAdapter(createNodeGitExecutor());

    await assertManagedWorktree(workdir, fixture.path, fixture.baseline, git);

    // Without the worktree .git entry, git discovery walks up into the real
    // checkout; the controller must refuse to operate in that directory.
    await fixture.git(['worktree', 'remove', '--force', workdir]).catch(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(join(workdir, '.git'), { force: true });
    });
    const { rm } = await import('node:fs/promises');
    await rm(join(workdir, '.git'), { force: true });
    await assert.rejects(
      assertManagedWorktree(workdir, fixture.path, fixture.baseline, git),
      /\.git|unexpected git root|missing/i,
    );
  } finally {
    await fixture.cleanup();
  }
});
