import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDeliveryReport } from '../../src/reporting/report-writer.js';
import type { RunState } from '../../src/domain/types.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';

test('report states that no finalization record exists when the journal is absent', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-report-'));
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'COMPLETED',
    repo_root: repo,
    created_at: '2026-10-28T00:00:00Z',
    updated_at: '2026-10-28T01:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: {
      run_id: 'run-1',
      requirements: [{ id: 'REQ-1', description: 'works', status: 'SATISFIED' }],
      acceptance: [],
      tasks: [],
    },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };

  const path = await writeDeliveryReport(repo, state);
  const content = await readFile(path, 'utf8');

  assert.match(content, /COMPLETED/);
  assert.match(content, /prepare-only/);
  assert.match(content, /no finalization record exists/i);
  assert.doesNotMatch(content, /未执行.*commit/i);
});

test('report reflects a completed finalization journal even when config remains prepare-only', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-report-'));
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-finalized',
    status: 'COMPLETED',
    repo_root: repo,
    created_at: '2026-11-03T00:00:00Z',
    updated_at: '2026-11-03T01:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-finalized', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
  const finalizationDirectory = join(repo, '.delivery', 'runs', state.run_id, 'finalization');
  await mkdir(finalizationDirectory, { recursive: true });
  await writeFile(join(finalizationDirectory, 'journal.json'), JSON.stringify({
    version: 1,
    run_id: state.run_id,
    action: 'push',
    status: 'completed',
    integration_snapshot_id: 'snapshot-1',
    completion_sha256: null,
    started_at: state.created_at,
    completed_at: state.updated_at,
    result: { head: 'abc123', branch: 'delivery/run-finalized' },
  }));

  const path = await writeDeliveryReport(repo, state);
  const content = await readFile(path, 'utf8');

  assert.match(content, /Finalization status: \*\*completed\*\*/);
  assert.match(content, /Finalization action: `push`/);
  assert.match(content, /abc123/);
  assert.match(content, /delivery\/run-finalized/);
  assert.doesNotMatch(content, /no finalization record exists/i);
  assert.doesNotMatch(content, /未执行.*commit/i);
});

test('report escapes pipes and line breaks in every Markdown table cell', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-report-'));
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-tables',
    status: 'COMPLETED',
    repo_root: repo,
    created_at: '2026-11-03T00:00:00Z',
    updated_at: '2026-11-03T01:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: {
      run_id: 'run-tables',
      requirements: [{ id: 'REQ|1\nnext', description: 'left|right\nsecond', status: 'SATISFIED' }],
      tasks: [{
        id: 'TASK|1\nnext',
        type: 'implementation',
        title: 'table escaping',
        status: 'DONE',
        priority: 'normal',
        risk: 'low',
        origin: 'initial_plan',
        depends_on: [],
        requirement_ids: [],
        acceptance_ids: [],
        scope_paths: [],
        required_outputs: [],
        worker_role: 'implementer',
        capability_profile: 'portable',
        attempt: 1,
        max_attempts: 3,
        verification_commands: [],
        review_policy: 'none',
        last_failure_fingerprint: 'failure|hash\nline',
      }],
    },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };

  const path = await writeDeliveryReport(repo, state, [{
    id: 'E|1\nnext',
    run_id: state.run_id,
    task_id: 'VERIFY',
    acceptance_ids: [],
    code_snapshot_id: 'snapshot|1\nnext',
    command: 'npm|test\n--all',
    cwd: repo,
    started_at: state.created_at,
    finished_at: state.updated_at,
    exit_code: 0,
    stdout_path: '',
    stderr_path: '',
    result: 'passed',
  }]);
  const content = await readFile(path, 'utf8');

  assert.match(content, /REQ\\\|1<br>next/);
  assert.match(content, /left\\\|right<br>second/);
  assert.match(content, /TASK\\\|1<br>next/);
  assert.match(content, /failure\\\|hash<br>line/);
  assert.match(content, /npm\\\|test<br>--all/);
  assert.match(content, /snapshot\\\|1<br>next/);
  assert.match(content, /E\\\|1<br>next/);
});
