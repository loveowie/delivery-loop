import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryViewService } from '../../src/dsh/view-service.js';
import { recordDecision } from '../../src/controller/decision-journal.js';
import { RunRegistry } from '../../src/runtime/run-registry.js';
import { StateStore } from '../../src/state/state-store.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState } from '../../src/domain/types.js';

async function gitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-view-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# Test\n');
  execFileSync('git', ['add', '.', '--'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

function stateFor(repo: string, runId: string): RunState {
  return {
    state_schema_version: 1,
    run_id: runId,
    status: 'RUNNING',
    repo_root: repo,
    created_at: '2026-11-16T00:00:00.000Z',
    updated_at: '2026-11-16T00:00:00.000Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: {
      run_id: runId,
      tasks: [{
        id: 'TASK-1',
        type: 'implementation',
        title: 'Add greeting',
        status: 'RUNNING',
        priority: 'normal',
        risk: 'low',
        origin: 'initial_plan',
        depends_on: [],
        requirement_ids: ['REQ-1'],
        acceptance_ids: ['ACC-1'],
        scope_paths: ['src/'],
        required_outputs: ['code'],
        worker_role: 'implementer',
        capability_profile: 'portable',
        attempt: 0,
        max_attempts: 3,
        verification_commands: ['npm test'],
        review_policy: 'none',
      }],
      requirements: [{ id: 'REQ-1', description: 'Greeting exists', status: 'PENDING' }],
      acceptance: [{
        id: 'ACC-1',
        requirement_id: 'REQ-1',
        description: 'Manual check',
        verification: { type: 'manual' },
        mandatory: true,
        risk: 'low',
      }],
    },
    current_task_ids: ['TASK-1'],
    pause_requested: false,
    pending_decision_ids: [],
    integration_worktree: repo,
    integration_snapshot_id: 'SNAP-1',
  };
}

test('view service exposes progress, decisions, files and artifact previews', async () => {
  const repo = await gitRepo();
  const registry = new RunRegistry(join(repo, '.registry'));
  const store = await StateStore.open(repo);
  await store.createRun(stateFor(repo, 'R-TEST'));
  await store.writeArtifact('R-TEST', 'spec.md', '# Demo delivery\n\nAdd a greeting.\n');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'greet.ts'), 'export const greet = () => "hi";\n');
  await store.updateRun('R-TEST', (draft) => {
    draft.graph.tasks[0]!.changed_files = ['src/greet.ts'];
    draft.graph.tasks[0]!.last_summary = 'Added greeting';
    return draft;
  });
  await recordDecision(store, {
    run_id: 'R-TEST',
    phase: 'dispatch',
    code: 'task_started',
    title: '开始任务 TASK-1',
    outcome: 'info',
    task_id: 'TASK-1',
  });
  await recordDecision(store, {
    run_id: 'R-TEST',
    phase: 'verify',
    code: 'verification_passed',
    title: '任务验证通过：TASK-1',
    outcome: 'pass',
    task_id: 'TASK-1',
  });

  const view = new DeliveryViewService(registry);
  const detail = await view.getRun('R-TEST', repo);
  assert.equal(detail.title, 'Demo delivery');
  assert.equal(detail.total_tasks, 1);
  assert.equal(detail.tasks[0]?.changed_files[0], 'src/greet.ts');
  assert.deepEqual(detail.decisions.map((decision) => decision.code), ['task_started', 'verification_passed']);
  assert.deepEqual(detail.files.changed, ['src/greet.ts']);
  assert.equal(detail.artifacts.some((artifact) => artifact.path === 'spec.md'), true);

  const file = await view.readFile('R-TEST', 'src/greet.ts', 'worktree', repo);
  assert.match(file.content, /export const greet/);
  const artifact = await view.readFile('R-TEST', 'spec.md', 'artifact', repo);
  assert.match(artifact.content, /Demo delivery/);
  const diff = await view.readDiff('R-TEST', 'src/greet.ts', repo);
  assert.match(diff, /new file mode/);

  const light = await view.getRun('R-TEST', repo, { includeFiles: false, includeArtifacts: false });
  assert.deepEqual(light.files.changed, []);
  assert.equal(light.artifacts.length, 0);
  assert.equal(light.tasks.length, 1);

  await assert.rejects(
    view.readFile('R-TEST', '../outside.txt', 'worktree', repo),
    /escape/,
  );
  await symlink('/etc/passwd', join(repo, 'src', 'outside-link'));
  await assert.rejects(
    view.readFile('R-TEST', 'src/outside-link', 'worktree', repo),
    /symlink/,
  );

  const emptyRepo = await gitRepo();
  assert.deepEqual(await view.listRuns(emptyRepo), []);
  assert.equal(existsSync(join(emptyRepo, '.delivery')), false);
});
