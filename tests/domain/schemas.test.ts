import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskGraph } from '../../src/domain/schemas.js';
import type { TaskGraph, TaskNode } from '../../src/domain/types.js';

function task(id: string, dependsOn: string[] = []): TaskNode {
  return {
    id,
    type: 'implementation',
    title: `Task ${id}`,
    status: 'PENDING',
    priority: 'normal',
    risk: 'medium',
    origin: 'initial_plan',
    depends_on: dependsOn,
    requirement_ids: ['REQ-001'],
    acceptance_ids: ['AC-001'],
    scope_paths: [`src/${id}`],
    required_outputs: ['code'],
    worker_role: 'implementer',
    capability_profile: 'portable',
    attempt: 0,
    max_attempts: 3,
    verification_commands: [],
    review_policy: 'risk-based',
  };
}

test('rejects cyclic task dependencies', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    tasks: [task('A', ['B']), task('B', ['A'])],
  };

  const result = validateTaskGraph(graph);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /cycle/i);
});

test('accepts an acyclic task graph and reports valid ready candidates', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    tasks: [task('A'), task('B', ['A'])],
  };
  graph.tasks[0]!.status = 'READY';

  const result = validateTaskGraph(graph);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('rejects a task that references an unknown dependency', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    tasks: [task('A', ['missing'])],
  };

  const result = validateTaskGraph(graph);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unknown dependency/i);
});

test('rejects unknown requirement and acceptance references', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'works', status: 'PENDING' }],
    acceptance: [
      {
        id: 'AC-1',
        requirement_id: 'REQ-missing',
        description: 'passes',
        verification: { type: 'manual' },
        mandatory: true,
        risk: 'low',
      },
    ],
    tasks: [task('A')],
  };

  const result = validateTaskGraph(graph);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /AC-1.*unknown requirement|REQ-missing/i);
});

test('rejects duplicate acceptance ids', () => {
  const condition = {
    id: 'AC-1',
    requirement_id: 'REQ-001',
    description: 'passes',
    verification: { type: 'manual' as const },
    mandatory: true,
    risk: 'low' as const,
  };
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-001', description: 'works', status: 'PENDING' }],
    acceptance: [condition, { ...condition }],
    tasks: [task('A')],
  };

  const result = validateTaskGraph(graph);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate acceptance/i);
});

test('rejects a requirement without a mandatory acceptance or a covering verification command', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'docs', status: 'PENDING' }],
    acceptance: [],
    tasks: [task('A')],
  };
  graph.tasks[0]!.requirement_ids = ['REQ-1'];
  graph.tasks[0]!.acceptance_ids = [];
  graph.tasks[0]!.verification_commands = [];

  const result = validateTaskGraph(graph);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /REQ-1.*mandatory acceptance.*verification command/i);
});

test('accepts a requirement covered by a mandatory acceptance even without task commands', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'manual review', status: 'PENDING' }],
    acceptance: [{
      id: 'AC-1',
      requirement_id: 'REQ-1',
      description: 'human approves',
      verification: { type: 'manual' },
      mandatory: true,
      risk: 'low',
    }],
    tasks: [task('A')],
  };
  graph.tasks[0]!.requirement_ids = ['REQ-1'];
  graph.tasks[0]!.acceptance_ids = [];
  graph.tasks[0]!.verification_commands = [];

  assert.equal(validateTaskGraph(graph).ok, true);
});

test('accepts a requirement covered by a task verification command', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'tests', status: 'PENDING' }],
    acceptance: [],
    tasks: [task('A')],
  };
  graph.tasks[0]!.requirement_ids = ['REQ-1'];
  graph.tasks[0]!.acceptance_ids = [];
  graph.tasks[0]!.verification_commands = ['npm test'];

  assert.equal(validateTaskGraph(graph).ok, true);
});
