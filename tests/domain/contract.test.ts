import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { validateDeliveryContract } from '../../src/domain/contract.js';
import type { DeliveryConfig, TaskGraph, TaskNode } from '../../src/domain/types.js';

function task(): TaskNode {
  return {
    id: 'T1',
    type: 'implementation',
    title: 't',
    status: 'READY',
    priority: 'normal',
    risk: 'low',
    origin: 'initial_plan',
    depends_on: [],
    requirement_ids: ['R'],
    acceptance_ids: [],
    scope_paths: ['src'],
    required_outputs: [],
    worker_role: 'implementer',
    capability_profile: 'portable',
    attempt: 0,
    max_attempts: 3,
    verification_commands: ['npm test'],
    review_policy: 'none',
  };
}

test('review acceptance requires final review to be enabled', () => {
  const graph: TaskGraph = {
    run_id: 'r',
    requirements: [{ id: 'R', description: 'r', status: 'PENDING' }],
    acceptance: [{
      id: 'AC-REV',
      requirement_id: 'R',
      description: 'reviewed',
      verification: { type: 'review' },
      mandatory: true,
      risk: 'low',
    }],
    tasks: [task()],
  };
  const config = structuredClone(DEFAULT_CONFIG) as DeliveryConfig;
  config.review.final_review = false;

  assert.match(validateDeliveryContract(graph, config).join('\n'), /final_review/i);
  config.review.final_review = true;
  assert.deepEqual(validateDeliveryContract(graph, config), []);
});

test('task capability profile must match the frozen run profile', () => {
  const graph: TaskGraph = {
    run_id: 'r',
    requirements: [{ id: 'R', description: 'r', status: 'PENDING' }],
    acceptance: [],
    tasks: [{ ...task(), capability_profile: 'openspec' }],
  };

  assert.match(
    validateDeliveryContract(graph, structuredClone(DEFAULT_CONFIG)).join('\n'),
    /capability_profile/,
  );
});

test('a contract with no requirement and no mandatory acceptance is rejected explicitly', () => {
  const empty: TaskGraph = { run_id: 'r', tasks: [], requirements: [], acceptance: [] };

  const errors = validateDeliveryContract(empty, structuredClone(DEFAULT_CONFIG));

  assert.match(errors.join('\n'), /no requirement/i);
  assert.match(errors.join('\n'), /mandatory acceptance/i);
});

test('a contract without any requirement cannot rely on acceptance conditions alone', () => {
  const graph: TaskGraph = {
    run_id: 'r',
    requirements: [],
    acceptance: [{
      id: 'AC-1',
      requirement_id: 'R',
      description: 'manual sign-off',
      verification: { type: 'manual' },
      mandatory: true,
      risk: 'low',
    }],
    tasks: [],
  };

  assert.match(
    validateDeliveryContract(graph, structuredClone(DEFAULT_CONFIG)).join('\n'),
    /at least one requirement/i,
  );
});

test('a requirement without mandatory acceptance or a verification command is rejected', () => {
  const graph: TaskGraph = {
    run_id: 'r',
    requirements: [{ id: 'R', description: 'r', status: 'PENDING' }],
    acceptance: [],
    tasks: [{ ...task(), verification_commands: [] }],
  };

  const errors = validateDeliveryContract(graph, structuredClone(DEFAULT_CONFIG)).join('\n');
  assert.match(errors, /requirement R/);
  assert.match(errors, /verification command/i);
});

test('a requirement covered by a task verification command needs no acceptance condition', () => {
  const graph: TaskGraph = {
    run_id: 'r',
    requirements: [{ id: 'R', description: 'r', status: 'PENDING' }],
    acceptance: [],
    tasks: [{ ...task(), verification_commands: ['npm test'] }],
  };

  assert.deepEqual(validateDeliveryContract(graph, structuredClone(DEFAULT_CONFIG)), []);
});

test('a pure manual approval contract is accepted', () => {
  const graph: TaskGraph = {
    run_id: 'r',
    requirements: [{ id: 'R', description: 'r', status: 'PENDING' }],
    acceptance: [{
      id: 'AC-1',
      requirement_id: 'R',
      description: 'human sign-off',
      verification: { type: 'manual' },
      mandatory: true,
      risk: 'low',
    }],
    tasks: [],
  };

  assert.deepEqual(validateDeliveryContract(graph, structuredClone(DEFAULT_CONFIG)), []);
});
