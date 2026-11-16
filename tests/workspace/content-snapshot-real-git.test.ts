import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changedSnapshotPaths,
  createCodeSnapshot,
} from '../../src/workspace/repository-context.js';
import { createGitFixture } from './git-fixture.js';

test('content identity is unchanged by staging and intent-to-add operations', async () => {
  const repo = await createGitFixture();
  try {
    await repo.write('src/tracked.txt', 'changed\n');
    await repo.write('src/new.bin', Buffer.from([0, 255, 10]));
    const before = await createCodeSnapshot(repo.path);

    await repo.git(['add', '--', 'src/tracked.txt']);
    await repo.git(['add', '-N', '--', 'src/new.bin']);
    const staged = await createCodeSnapshot(repo.path);

    await repo.git(['reset', '--mixed', 'HEAD']);
    const unstaged = await createCodeSnapshot(repo.path);

    assert.equal(staged.id, before.id);
    assert.equal(unstaged.id, before.id);
    assert.equal(staged.worktree_digest, before.worktree_digest);
    assert.deepEqual(staged.untracked_files, ['src/new.bin']);
  } finally {
    await repo.cleanup();
  }
});

test('content identity covers deletion, executable mode, symlink target, unusual paths, and excludes .delivery', async () => {
  const repo = await createGitFixture();
  try {
    await repo.write('src/mode.sh', '#!/bin/sh\nexit 0\n');
    await repo.write('src/name with space\nand newline.txt', 'odd path\n');
    await symlink('tracked.txt', join(repo.path, 'src', 'link'));
    await mkdir(join(repo.path, '.delivery', 'runs'), { recursive: true });
    await repo.write('.delivery/runs/state.json', 'first');

    const initial = await createCodeSnapshot(repo.path);
    assert.deepEqual(initial.untracked_files, [
      'src/link',
      'src/mode.sh',
      'src/name with space\nand newline.txt',
    ]);

    await repo.write('.delivery/runs/state.json', 'second');
    assert.equal((await createCodeSnapshot(repo.path)).id, initial.id);

    await chmod(join(repo.path, 'src', 'mode.sh'), 0o755);
    const executable = await createCodeSnapshot(repo.path);
    assert.notEqual(executable.id, initial.id);

    await rm(join(repo.path, 'src', 'link'));
    await symlink('mode.sh', join(repo.path, 'src', 'link'));
    const retargeted = await createCodeSnapshot(repo.path);
    assert.notEqual(retargeted.id, executable.id);

    await rm(join(repo.path, 'src', 'tracked.txt'));
    const deleted = await createCodeSnapshot(repo.path);
    assert.notEqual(deleted.id, retargeted.id);
  } finally {
    await repo.cleanup();
  }
});

test('content identity does not depend on the commit containing identical bytes', async () => {
  const repo = await createGitFixture();
  try {
    const before = await createCodeSnapshot(repo.path);
    await repo.write('src/tracked.txt', 'intermediate\n');
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'intermediate']);
    await repo.write('src/tracked.txt', 'baseline\n');
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'restore bytes']);

    const after = await createCodeSnapshot(repo.path);

    assert.notEqual(after.baseline_commit, before.baseline_commit);
    assert.equal(after.worktree_digest, before.worktree_digest);
    assert.equal(after.id, before.id);
  } finally {
    await repo.cleanup();
  }
});

test('snapshot comparison excludes accepted seed changes and includes staged task edits', async () => {
  const repo = await createGitFixture();
  try {
    await repo.write('src/accepted.txt', 'baseline accepted\n');
    await repo.write('src/task.txt', 'baseline task\n');
    await repo.write('outside.txt', 'baseline outside\n');
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'comparison baseline']);

    await repo.write('src/accepted.txt', 'accepted integration content\n');
    await repo.git(['add', '--', 'src/accepted.txt']);
    const accepted = await createCodeSnapshot(repo.path);

    await repo.write('src/task.txt', 'task content\n');
    await repo.write('outside.txt', 'malicious staged content\n');
    await repo.git(['add', '--', 'outside.txt']);
    const task = await createCodeSnapshot(repo.path);

    assert.ok(accepted.content_manifest);
    assert.ok(task.content_manifest);
    assert.deepEqual(changedSnapshotPaths(accepted, task), ['outside.txt', 'src/task.txt']);
  } finally {
    await repo.cleanup();
  }
});

test('committing a deletion does not change the identity of the resulting content', async () => {
  const repo = await createGitFixture();
  try {
    await repo.write('src/delete-me.txt', 'remove this\n');
    await repo.git(['add', '--', 'src/delete-me.txt']);
    await repo.git(['commit', '-m', 'add deletion target']);
    const beforeDeletion = await createCodeSnapshot(repo.path);

    await rm(join(repo.path, 'src', 'delete-me.txt'));
    const deletedWorktree = await createCodeSnapshot(repo.path);
    assert.deepEqual(changedSnapshotPaths(beforeDeletion, deletedWorktree), ['src/delete-me.txt']);

    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'delete target']);
    const committedDeletion = await createCodeSnapshot(repo.path);

    assert.equal(committedDeletion.id, deletedWorktree.id);
    assert.equal(committedDeletion.worktree_digest, deletedWorktree.worktree_digest);
    assert.deepEqual(committedDeletion.content_manifest, deletedWorktree.content_manifest);
  } finally {
    await repo.cleanup();
  }
});
