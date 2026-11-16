import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkerLock } from '../../src/runtime/worker-lock.js';

test('worker lock prevents duplicate detached controllers for one run', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-worker-lock-'));
  const first = await acquireWorkerLock(repo, 'run-1');
  const second = await acquireWorkerLock(repo, 'run-1');

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  await first.release();

  const third = await acquireWorkerLock(repo, 'run-1');
  assert.equal(third.acquired, true);
  await third.release();
});

test('concurrent worker lock acquisition has exactly one owner', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-worker-lock-'));
  const locks = await Promise.all([
    acquireWorkerLock(repo, 'run-1'),
    acquireWorkerLock(repo, 'run-1'),
  ]);

  assert.equal(locks.filter((lock) => lock.acquired).length, 1);
  await Promise.all(locks.map((lock) => lock.release()));
});
