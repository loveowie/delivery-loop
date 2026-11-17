import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunRegistry } from '../../src/runtime/run-registry.js';

test('concurrent registrations preserve both run mappings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'delivery-loop-registry-'));
  const registry = new RunRegistry(home);

  await Promise.all([
    registry.register('run-1', '/repo/one'),
    registry.register('run-2', '/repo/two'),
  ]);

  assert.equal(await registry.lookup('run-1'), '/repo/one');
  assert.equal(await registry.lookup('run-2'), '/repo/two');
});

test('a run id cannot silently move to another repository', async () => {
  const home = await mkdtemp(join(tmpdir(), 'delivery-loop-registry-'));
  const registry = new RunRegistry(home);
  await registry.register('run-1', '/repo/one');

  await assert.rejects(registry.register('run-1', '/repo/two'), /already registered/i);
  assert.equal(await registry.lookup('run-1'), '/repo/one');
});
