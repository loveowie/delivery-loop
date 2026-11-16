import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunTransition, assertTaskTransition } from '../../src/scheduler/state-machine.js';

test('allows a reviewing task to enter integration', () => {
  assert.doesNotThrow(() => assertTaskTransition('REVIEWING', 'INTEGRATING'));
});

test('rejects skipping verification before integration', () => {
  assert.throws(() => assertTaskTransition('RUNNING', 'INTEGRATING'), /invalid task transition/i);
});

test('terminal run states cannot transition', () => {
  assert.throws(() => assertRunTransition('COMPLETED', 'RUNNING'), /invalid run transition/i);
});
