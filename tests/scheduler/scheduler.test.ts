import test from 'node:test';
import assert from 'node:assert/strict';
import { failureFingerprint } from '../../src/scheduler/failure-fingerprint.js';
import { promotePendingTasks, selectReadyTasks } from '../../src/scheduler/scheduler.js';
import type { TaskGraph, TaskNode } from '../../src/domain/types.js';

function task(
  id: string,
  status: TaskNode['status'],
  dependsOn: string[] = [],
  scope = `src/${id}`,
): TaskNode {
  return {
    id,
    type: 'implementation',
    title: id,
    status,
    priority: 'normal',
    risk: 'medium',
    origin: 'initial_plan',
    depends_on: dependsOn,
    requirement_ids: ['REQ-001'],
    acceptance_ids: ['AC-001'],
    scope_paths: [scope],
    required_outputs: ['code'],
    worker_role: 'implementer',
    capability_profile: 'portable',
    attempt: 0,
    max_attempts: 3,
    verification_commands: [],
    review_policy: 'risk-based',
  };
}

test('downstream task remains pending until dependency is integrated', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    tasks: [task('A', 'VERIFYING'), task('B', 'PENDING', ['A'])],
  };

  assert.deepEqual(selectReadyTasks(graph, { maxWorkers: 2 }), []);
});

test('pending task is promoted after its dependency is integrated', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    tasks: [task('A', 'DONE'), task('B', 'PENDING', ['A'])],
  };

  assert.deepEqual(promotePendingTasks(graph), ['B']);
  assert.equal(graph.tasks[1]?.status, 'READY');
});

test('disjoint ready tasks respect the worker limit', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    tasks: [task('A', 'READY'), task('B', 'READY'), task('C', 'READY')],
  };

  assert.equal(selectReadyTasks(graph, { maxWorkers: 2 }).length, 2);
});

test('conflicting scopes are not scheduled together when a running task holds the scope', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    tasks: [task('A', 'RUNNING', [], 'src/shared'), task('B', 'READY', [], 'src/shared')],
  };

  assert.deepEqual(selectReadyTasks(graph, { maxWorkers: 2 }), []);
});

test('failure fingerprints are stable across timestamps and unstable stack addresses', () => {
  const left = failureFingerprint({
    taskId: 'TASK-1',
    command: 'npm test',
    output: 'Error at 0x1234\n2026-10-28T10:00:00Z failure',
  });
  const right = failureFingerprint({
    taskId: 'TASK-1',
    command: 'npm test',
    output: 'Error at 0xabcd\n2026-10-28T10:05:00Z failure',
  });

  assert.equal(left, right);
});
