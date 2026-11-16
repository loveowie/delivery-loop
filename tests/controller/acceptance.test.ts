import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAcceptance } from '../../src/controller/acceptance.js';
import type { EvidenceRecord, TaskGraph } from '../../src/domain/types.js';

function graphWithManualAcceptance(): TaskGraph {
  return {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'desired behavior', status: 'SATISFIED' }],
    acceptance: [
      {
        id: 'AC-1',
        requirement_id: 'REQ-1',
        description: 'user confirms the visible result',
        verification: { type: 'manual' },
        mandatory: true,
        risk: 'low',
      },
    ],
    tasks: [],
  };
}

test('manual acceptance blocks completion', () => {
  const result = evaluateAcceptance(graphWithManualAcceptance(), []);

  assert.equal(result.status, 'WAITING_HUMAN');
  assert.match(result.reasons.join('\n'), /AC-1/);
});

test('manual acceptance passes when a recorded human approval exists', () => {
  const evidence: EvidenceRecord = {
    id: 'E-MANUAL',
    run_id: 'run-1',
    task_id: 'ACCEPTANCE',
    acceptance_ids: ['AC-1'],
    code_snapshot_id: 'SNAP-1',
    command: 'manual-approval',
    cwd: '/repo',
    started_at: '2026-10-28T00:00:00Z',
    finished_at: '2026-10-28T00:00:01Z',
    exit_code: 0,
    stdout_path: '/tmp/stdout.log',
    stderr_path: '/tmp/stderr.log',
    result: 'passed',
  };

  assert.equal(evaluateAcceptance(graphWithManualAcceptance(), [evidence]).status, 'PASSED');
});

test('command acceptance passes only with matching current evidence', () => {
  const graph = graphWithManualAcceptance();
  graph.acceptance![0] = {
    id: 'AC-1',
    requirement_id: 'REQ-1',
    description: 'tests pass',
    verification: { type: 'command', command: 'npm test', expected_exit_code: 0 },
    mandatory: true,
    risk: 'low',
  };
  const evidence: EvidenceRecord = {
    id: 'E-1',
    run_id: 'run-1',
    task_id: 'TASK-1',
    acceptance_ids: ['AC-1'],
    code_snapshot_id: 'SNAP-1',
    command: 'npm test',
    cwd: '/repo',
    started_at: '2026-10-28T00:00:00Z',
    finished_at: '2026-10-28T00:00:01Z',
    exit_code: 0,
    stdout_path: '/tmp/stdout.log',
    stderr_path: '/tmp/stderr.log',
    result: 'passed',
  };

  assert.equal(evaluateAcceptance(graph, [evidence]).status, 'PASSED');
});

test('passing acceptance evidence satisfies its associated requirement even when the stored status is stale', () => {
  const graph = graphWithManualAcceptance();
  graph.requirements![0]!.status = 'PENDING';
  graph.acceptance![0] = {
    id: 'AC-1',
    requirement_id: 'REQ-1',
    description: 'tests pass',
    verification: { type: 'command', command: 'npm test', expected_exit_code: 0 },
    mandatory: true,
    risk: 'low',
  };
  const evidence: EvidenceRecord = {
    id: 'E-1',
    run_id: 'run-1',
    task_id: 'TASK-1',
    acceptance_ids: ['AC-1'],
    code_snapshot_id: 'SNAP-1',
    command: 'npm test',
    cwd: '/repo',
    started_at: '2026-10-28T00:00:00Z',
    finished_at: '2026-10-28T00:00:01Z',
    exit_code: 0,
    stdout_path: '/tmp/stdout.log',
    stderr_path: '/tmp/stderr.log',
    result: 'passed',
  };

  const result = evaluateAcceptance(graph, [evidence]);
  assert.equal(result.status, 'PASSED');
});

test('a requirement without acceptance or a completed task remains unsatisfied', () => {
  const graph: TaskGraph = {
    run_id: 'run-1',
    requirements: [{ id: 'REQ-1', description: 'works', status: 'PENDING' }],
    acceptance: [],
    tasks: [],
  };

  const result = evaluateAcceptance(graph, []);

  assert.equal(result.status, 'FAILED');
  assert.match(result.reasons.join('\n'), /REQ-1/);
});

test('DONE tasks and SATISFIED input do not substitute current independent evidence',()=>{
  const graph:TaskGraph={run_id:'run',requirements:[{id:'R',description:'feature',status:'SATISFIED'}],acceptance:[],tasks:[]};
  assert.equal(evaluateAcceptance(graph,[],'S').status,'FAILED');
});


test('an empty delivery contract cannot establish successful acceptance',()=>{
  const result=evaluateAcceptance({run_id:'empty',tasks:[]},[]);
  assert.equal(result.status,'FAILED');assert.match(result.reasons.join(' '),/requirement|acceptance|contract/i);
});
