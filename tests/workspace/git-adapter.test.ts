import test from 'node:test';
import assert from 'node:assert/strict';
import { GuardedGitAdapter } from '../../src/workspace/git-adapter.js';

test('git adapter rejects commit without approval token', async () => {
  const adapter = new GuardedGitAdapter(async () => ({ stdout: '', stderr: '', exitCode: 0 }));

  await assert.rejects(adapter.exec(['commit', '-m', 'message'], '/repo'), /approval/i);
});

test('git adapter permits read-only inspection without approval', async () => {
  const adapter = new GuardedGitAdapter(async () => ({
    stdout: 'abc\n',
    stderr: '',
    exitCode: 0,
  }));

  const result = await adapter.exec(['rev-parse', 'HEAD'], '/repo');

  assert.equal(result.stdout, 'abc\n');
});

test('git adapter permits a write with a matching run approval', async () => {
  const calls: string[][] = [];
  const adapter = new GuardedGitAdapter(async (args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await adapter.exec(['worktree', 'add', '--detach', '/tmp/wt', 'abc'], '/repo', {
    run_id: 'run-1',
  });

  assert.deepEqual(calls[0], ['worktree', 'add', '--detach', '/tmp/wt', 'abc']);
});
