import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GuardedGitAdapter, createNodeGitExecutor } from '../../src/workspace/git-adapter.js';
import { PatchIntegrator } from '../../src/workspace/patch-integrator.js';
import { createCodeSnapshot } from '../../src/workspace/repository-context.js';
import { createGitFixture } from './git-fixture.js';

const git = new GuardedGitAdapter(createNodeGitExecutor());

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true).catch(() => false);
}

test('a later task can delete or rename a file added by an earlier integrated task', async () => {
  const fixture = await createGitFixture();
  try {
    const runWorktrees = join(fixture.path, '.delivery', 'runs', 'run-1', 'worktrees');
    await mkdir(runWorktrees, { recursive: true });
    const accepted = join(runWorktrees, 'accepted');
    await git.exec(['worktree', 'add', '--detach', accepted, fixture.baseline], fixture.path, { run_id: 'run-1' });

    // Task 1's accepted integration: two new files staged on top of the baseline.
    await mkdir(join(accepted, 'src'), { recursive: true });
    await writeInto(accepted, 'src/new.txt', 'from task 1\n');
    await writeInto(accepted, 'src/old.txt', 'rename me\n');
    await git.exec(['add', '-A'], accepted, { run_id: 'run-1' });

    const acceptedSnapshot = await createCodeSnapshot(accepted);

    const integrator = new PatchIntegrator(git);
    const artifactDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-patch-'));
    const seed = await integrator.exportTaskPatch(
      accepted,
      fixture.baseline,
      artifactDirectory,
      acceptedSnapshot.untracked_files,
      { run_id: 'run-1' },
    );

    const task = join(runWorktrees, 'task-2');
    await git.exec(['worktree', 'add', '--detach', task, fixture.baseline], fixture.path, { run_id: 'run-1' });
    await integrator.applyToIntegration(task, seed.path, { run_id: 'run-1' });
    await git.exec(['add', '-A'], task, { run_id: 'run-1' });
    await integrator.freezeDeltaBase(task);
    const before = await createCodeSnapshot(task);
    assert.ok(before.content_manifest?.['src/new.txt']);

    // Task 2 deletes one file and renames the other.
    await rm(join(task, 'src', 'new.txt'));
    await git.exec(['mv', 'src/old.txt', 'src/renamed.txt'], task, { run_id: 'run-1' });

    const after = await createCodeSnapshot(task);
    const delta = await integrator.exportDeltaPatch(
      task,
      artifactDirectory,
      after.untracked_files,
      { run_id: 'run-1' },
      { requireFrozenBase: true },
    );
    assert.ok(delta.sha256.length > 0);

    const candidate = join(runWorktrees, 'candidate');
    await git.exec(['worktree', 'add', '--detach', candidate, fixture.baseline], fixture.path, { run_id: 'run-1' });
    await integrator.applyToIntegration(candidate, seed.path, { run_id: 'run-1' });
    await git.exec(['add', '-A'], candidate, { run_id: 'run-1' });
    const applied = await integrator.applyToIntegration(candidate, delta.path, { run_id: 'run-1' });
    assert.deepEqual(applied, { ok: true });

    assert.equal(await exists(join(candidate, 'src', 'new.txt')), false);
    assert.equal(await exists(join(candidate, 'src', 'old.txt')), false);
    assert.equal(await exists(join(candidate, 'src', 'renamed.txt')), true);
  } finally {
    await fixture.cleanup();
  }
});

async function writeInto(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}
