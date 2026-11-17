/**
 * Create a synthetic delivery run for previewing the DSH delivery view.
 *
 * The run lives in its own temporary Git repository so it never pollutes a
 * real project. It is registered in ~/.delivery-loop/runs.json, so it appears
 * under Settings -> Delivery loop immediately.
 *
 * Usage: npm run demo:view
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { recordDecision } from '../src/controller/decision-journal.js';
import { RunRegistry } from '../src/runtime/run-registry.js';
import { StateStore } from '../src/state/state-store.js';
import type { RunState, TaskNode } from '../src/domain/types.js';

function task(overrides: Partial<TaskNode> & Pick<TaskNode, 'id' | 'title' | 'status'>): TaskNode {
  return {
    type: 'implementation',
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
    review_policy: 'required',
    ...overrides,
  };
}

const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-view-demo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Delivery Demo'], { cwd: repo });
await writeFile(join(repo, 'README.md'), '# Delivery view demo\n');
execFileSync('git', ['add', '.', '--'], { cwd: repo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

await mkdir(join(repo, 'src'), { recursive: true });
await writeFile(join(repo, 'src', 'greet.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n');
await mkdir(join(repo, 'src', '__tests__'), { recursive: true });
await writeFile(join(repo, 'src', 'cli.ts'), 'import { greet } from "./greet.js";\n\nconsole.log(greet(process.argv[2] ?? "world"));\n');
await writeFile(join(repo, 'src', '__tests__', 'greet.test.ts'), 'import { greet } from "../greet.js";\n\nif (greet("DSH") !== "Hello, DSH!") throw new Error("bad greeting");\n');

const runId = `DEMO-VIEW-${Date.now().toString(36).toUpperCase()}`;
const now = new Date().toISOString();
const tasks: TaskNode[] = [
  task({
    id: 'TASK-1',
    title: 'Add greeting module',
    status: 'DONE',
    attempt: 1,
    changed_files: ['src/greet.ts'],
    last_summary: 'Added the greeting function and its test.',
    code_snapshot_id: 'SNAP-1',
  }),
  task({
    id: 'TASK-2',
    title: 'Wire greeting into the CLI',
    status: 'DONE',
    risk: 'medium',
    depends_on: ['TASK-1'],
    attempt: 1,
    changed_files: ['src/cli.ts'],
    last_summary: 'Updating the CLI entry point.',
  }),
  task({
    id: 'TASK-3',
    title: 'Document the greeting command',
    status: 'DONE',
    type: 'documentation',
    depends_on: ['TASK-2'],
    required_outputs: ['documentation'],
  }),
];

const state: RunState = {
  state_schema_version: 1,
  run_id: runId,
  status: 'COMPLETED',
  repo_root: repo,
  baseline_commit: baseline,
  created_at: now,
  updated_at: now,
  config: { ...structuredClone(DEFAULT_CONFIG), git: { ...DEFAULT_CONFIG.git, mode: 'prepare-only' } },
  graph: {
    run_id: runId,
    tasks,
    requirements: [
      { id: 'REQ-1', description: 'The CLI greets the user by name.', status: 'SATISFIED' },
    ],
    acceptance: [
      {
        id: 'ACC-1',
        requirement_id: 'REQ-1',
        description: 'A maintainer confirms the greeting reads correctly.',
        verification: { type: 'manual' },
        mandatory: true,
        risk: 'low',
      },
    ],
  },
  current_task_ids: [],
  pause_requested: false,
  pending_decision_ids: [],
  decisions: [{ decision_id: 'ACC-1', response: 'approve', answered_at: now }],
  integration_worktree: repo,
  integration_snapshot_id: 'SNAP-1',
  total_tokens_used: 12_480,
  usage_incomplete: false,
};

const store = await StateStore.open(repo);
await store.createRun(state);
await store.writeArtifact(runId, 'spec.md', `# Demo: greeting CLI

Add a greeting module, wire it into the CLI, and document the command.

This is a synthetic run created by \`npm run demo:view\` to preview the Delivery Loop view.
`);
await store.writeArtifact(runId, 'task-graph.json', `${JSON.stringify(state.graph, null, 2)}\n`);
await store.writeArtifact(runId, 'reports/final.md', `# Delivery Report: ${runId}\n\n_Demo report._\n`);
await store.writeArtifact(runId, 'evidence/E-DEMO.stdout.log', 'greeting tests passed\n');

await recordDecision(store, { run_id: runId, phase: 'prepare', code: 'baseline_passed', title: '基线验证完成', outcome: 'pass', data: { commands: 2 } });
await recordDecision(store, { run_id: runId, phase: 'lifecycle', code: 'run_started', title: '交付运行开始执行', outcome: 'info', data: { max_parallel_workers: 2 } });
await recordDecision(store, { run_id: runId, phase: 'dispatch', code: 'task_started', title: '开始任务 TASK-1', detail: 'Add greeting module（角色：implementer，第 1 次尝试）', outcome: 'info', task_id: 'TASK-1' });
await recordDecision(store, { run_id: runId, phase: 'execute', code: 'worker_completed', title: 'Worker 提交结果：TASK-1', detail: 'Added the greeting function and its test.', outcome: 'pass', task_id: 'TASK-1' });
await recordDecision(store, { run_id: runId, phase: 'verify', code: 'verification_passed', title: '任务验证通过：TASK-1', outcome: 'pass', task_id: 'TASK-1' });
await recordDecision(store, { run_id: runId, phase: 'review', code: 'review_passed', title: '独立评审通过：TASK-1', detail: 'No blocking findings.', outcome: 'pass', task_id: 'TASK-1' });
await recordDecision(store, { run_id: runId, phase: 'integrate', code: 'integration_passed', title: '集成并通过验证：TASK-1', outcome: 'pass', task_id: 'TASK-1' });
await recordDecision(store, { run_id: runId, phase: 'dispatch', code: 'task_started', title: '开始任务 TASK-2', detail: 'Wire greeting into the CLI（角色：implementer，第 1 次尝试）', outcome: 'info', task_id: 'TASK-2' });
await recordDecision(store, { run_id: runId, phase: 'verify', code: 'verification_failed', title: '任务验证失败：TASK-2', detail: 'npm test 退出码 1', outcome: 'fail', task_id: 'TASK-2' });
await recordDecision(store, { run_id: runId, phase: 'dispatch', code: 'fix_task_created', title: '创建修复任务：FIX-DEMO', detail: '任务 TASK-2 因 test_failure 进入修复流程。', outcome: 'info', task_id: 'TASK-2' });
await recordDecision(store, { run_id: runId, phase: 'accept', code: 'acceptance_passed', title: '验收通过，交付完成', detail: '所有强制验收条件均有可追溯证据支持。', outcome: 'pass' });

await new RunRegistry().register(runId, repo);
console.log(`Created demo delivery run ${runId}`);
console.log(`Repository: ${repo}`);
console.log('Open Settings -> Delivery loop, or refresh and open the Delivery Loop strip in a session whose cwd is that repository.');
console.log('Delete this demo by removing the repository directory and its entry from ~/.delivery-loop/runs.json.');
