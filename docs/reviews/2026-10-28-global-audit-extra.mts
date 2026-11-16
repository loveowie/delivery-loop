import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, access, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { StateStore } from '../../src/state/state-store.ts';
import { EvidenceLedger } from '../../src/state/evidence-ledger.ts';
import { DeliveryController } from '../../src/controller/delivery-controller.ts';
import { recoverInterruptedRun } from '../../src/controller/recovery.ts';
import { createCodeSnapshot } from '../../src/workspace/repository-context.ts';
import { WorktreeManager } from '../../src/workspace/worktree-manager.ts';
import { GuardedGitAdapter, createNodeGitExecutor } from '../../src/workspace/git-adapter.ts';
import { PatchIntegrator } from '../../src/workspace/patch-integrator.ts';
import { PatchIntegrationAdapter } from '../../src/workspace/patch-integration-adapter.ts';
import { CommandRunner } from '../../src/verification/command-runner.ts';
import { DeliveryRunManager } from '../../src/runtime/run-manager.ts';
import { RunRegistry } from '../../src/runtime/run-registry.ts';
import { validateTaskGraph } from '../../src/domain/schemas.ts';
import { evaluateAcceptance } from '../../src/controller/acceptance.ts';

const exec = promisify(execFile);
const results: any[] = [];
async function git(repo: string, args: string[]) {
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: repo })).stdout;
}
function task(id = 'TASK-1') {
  return { id, type: 'implementation', title: 'Implement approved feature', status: 'READY',
    priority: 'normal', risk: 'low', origin: 'initial_plan', depends_on: [],
    requirement_ids: [], acceptance_ids: [], scope_paths: ['src'], required_outputs: [],
    worker_role: 'implementer', capability_profile: 'portable', attempt: 0,
    max_attempts: 3, verification_commands: [], review_policy: 'none' } as any;
}
function completed(request: any, extra = {}) {
  return { task_id: request.task_id, status: 'completed', summary: 'done', files_changed: [],
    commands_run: [], findings: [], remaining_risks: [], suggested_tasks: [], blockers: [], ...extra } as any;
}
async function fixture(finalReview = false, worker?: any) {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-audit-case-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.name', 'Audit']);
  await git(repo, ['config', 'user.email', 'audit@example.invalid']);
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, '.gitignore'), '.delivery/\n');
  await writeFile(join(repo, 'src/base.txt'), 'baseline\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'baseline']);
  const baseline = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const config = structuredClone(DEFAULT_CONFIG);
  config.review.final_review = finalReview;
  config.verification.baseline = false;
  const now = new Date().toISOString();
  const state: any = { state_schema_version: 1, run_id: 'run-1', status: 'RUNNING',
    repo_root: repo, baseline_commit: baseline, created_at: now, updated_at: now,
    config, graph: { run_id: 'run-1', tasks: [task()] }, current_task_ids: [],
    pause_requested: false, pending_decision_ids: [] };
  const store = await StateStore.open(repo);
  await store.createRun(state);
  await store.writeArtifact('run-1', 'spec.md', 'APPROVED: feature must return 42; never return 7.');
  const executor = new GuardedGitAdapter(createNodeGitExecutor());
  const patches = new PatchIntegrator(executor);
  const worktrees = new WorktreeManager(repo, executor, patches);
  const snapshots = {
    async create(workdir: string) { return createCodeSnapshot(workdir); },
    async changedFiles(workdir: string) {
      return (await git(workdir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
        .split('\0').filter(e => e.length > 3).filter(e => e.startsWith('??') || e[1] !== ' ')
        .map(e => e.slice(3)).filter(p => p !== '.delivery' && !p.startsWith('.delivery/'));
    },
  };
  const integrator = new PatchIntegrationAdapter({ worktrees, patchIntegrator: patches,
    snapshots, runDirectory: store.getRunDirectory('run-1') });
  const requests: any[] = [];
  const controller = new DeliveryController({ repoRoot: repo, store, worktrees,
    snapshots, integrator, verifier: new CommandRunner(repo), evidenceLedger: new EvidenceLedger(repo),
    skills: { async resolve() { return []; }, async verifyAll() {} },
    workers: { async run(request: any, options: any) {
      requests.push(request);
      if (worker) return worker(request, options);
      if (request.role === 'implementer') await writeFile(join(request.workdir, 'src/base.txt'), 'changed\n');
      return completed(request);
    } },
  });
  return { repo, store, controller, worktrees, snapshots, state, requests, patches };
}

import { CodexExecAdapter } from '../../src/workers/codex-exec-adapter.ts';

// Diagnostic probes only: no production source changes and no real model calls.
{
  const f = await fixture(false);
  await f.store.updateRun('run-1', s => {
    s.config.verification.commands.test = [
      `node -e "require('node:fs').writeFileSync('src/base.txt', 'changed by final verification')"`,
    ];
    return s;
  });
  const state = await f.controller.tick('run-1');
  const actual = await createCodeSnapshot(state.integration_worktree!);
  results.push({ case: 'final verifier changes accepted source without snapshot refresh',
    runStatus: state.status, publishedSnapshot: state.integration_snapshot_id,
    actualSnapshot: actual.id, snapshotsMatch: actual.id === state.integration_snapshot_id,
    finalContent: await readFile(join(state.integration_worktree!, 'src/base.txt'), 'utf8') });
}

{
  const f = await fixture(false, async (r: any) => {
    await writeFile(join(r.workdir, 'src/base.txt'), 'unverified candidate\n');
    return completed(r);
  });
  await f.store.updateRun('run-1', s => {
    s.graph.tasks[0]!.verification_commands = [
      `node -e "process.exit(process.cwd().endsWith('integration-worktree') ? 1 : 0)"`,
    ];
    return s;
  });
  const state = await f.controller.tick('run-1');
  results.push({ case: 'failed integration candidate remains published',
    sourceTask: state.graph.tasks[0]!.status,
    publishedSnapshot: state.integration_snapshot_id,
    integrationContent: await readFile(join(state.integration_worktree!, 'src/base.txt'), 'utf8') });
}

{
  const f = await fixture(false, async (r: any) => {
    await writeFile(join(r.workdir, 'src/base.txt'), 'in scope\n');
    await writeFile(join(r.workdir, 'outside-scope.txt'), 'staged outside scope\n');
    await git(r.workdir, ['add', 'outside-scope.txt']);
    return completed(r);
  });
  const state = await f.controller.tick('run-1');
  const workdir = f.worktrees.taskPath('run-1', 'TASK-1', 0);
  results.push({ case: 'staged out of scope change omitted by scope guard',
    runStatus: state.status, sourceTask: state.graph.tasks[0]!.status,
    workerStatus: await git(workdir, ['status', '--porcelain']),
    integratedOutsideScope: await access(join(state.integration_worktree!, 'outside-scope.txt'))
      .then(() => true, () => false) });
}

{
  const roles: string[] = [];
  const f = await fixture(false, async (r: any) => {
    roles.push(r.role);
    await writeFile(join(r.workdir, 'src/base.txt'), 'changed\n');
    return completed(r);
  });
  await f.store.updateRun('run-1', s => {
    s.config.review.task_review_policy = 'always';
    s.graph.tasks[0]!.review_policy = 'none';
    return s;
  });
  const state = await f.controller.tick('run-1');
  results.push({ case: 'global always review overridden by task none', runStatus: state.status, roles });
}

{
  const command = `node -e "process.exit(2)"`;
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-expected-exit-'));
  const record = await new CommandRunner(repo).run({ run_id: 'run-1', task_id: 'TASK-1',
    acceptance_ids: ['AC-1'], code_snapshot_id: 'SNAP-1', command, cwd: repo, timeout_seconds: 5 });
  const graph: any = { run_id: 'run-1', tasks: [],
    requirements: [{ id: 'REQ-1', description: 'expected rejection', status: 'PENDING' }],
    acceptance: [{ id: 'AC-1', requirement_id: 'REQ-1', description: 'exits 2', mandatory: true,
      risk: 'low', verification: { type: 'command', command, expected_exit_code: 2 } }] };
  results.push({ case: 'expected nonzero exit cannot satisfy acceptance',
    exitCode: record.exit_code, evidenceResult: record.result,
    acceptance: evaluateAcceptance(graph, [record], 'SNAP-1') });
}

{
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-adapter-probe-'));
  const fake = join(root, 'fake-worker.cjs');
  await writeFile(fake, `#!/usr/bin/env node\nconst fs = require('node:fs');\n` +
    `const args = process.argv.slice(2);\n` +
    `const path = args[args.indexOf('--output-last-message') + 1];\n` +
    `fs.writeFileSync(path, JSON.stringify({ task_id: 'OTHER-TASK', status: 'completed', summary: 'fixture', files_changed: [], commands_run: [], findings: [], remaining_risks: [], suggested_tasks: [], blockers: [], token_usage: 0 }));\n` +
    `process.stdout.write(JSON.stringify({total_tokens: 999}) + '\\n');\n`);
  await chmod(fake, 0o700);
  const request: any = { run_id: 'run-1', task_id: 'TASK-1', role: 'implementer',
    capability_profile: 'portable', required_skills: [], objective: 'fixture', workdir: root,
    requirement_ids: [], acceptance_ids: [], scope_paths: [], constraints: [],
    verification_commands: [], context_files: [], timeout_seconds: 5 };
  const result = await new CodexExecAdapter({ schemaPath: join(process.cwd(), 'schemas/agent-result.schema.json'), command: fake }).run(request);
  results.push({ case: 'worker result identity and self-reported usage trusted',
    requestedTask: request.task_id, returnedTask: result.task_id,
    status: result.status, measuredUsage: 999, returnedUsage: result.token_usage });

  const pidFile = join(root, 'pid');
  await writeFile(fake, `#!/usr/bin/env node\nconst fs = require('node:fs');\n` +
    `process.on('SIGTERM', () => {});\n` +
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
    `setInterval(() => {}, 1000);\n`);
  const cancellation = new AbortController();
  const pending = new CodexExecAdapter({ schemaPath: join(process.cwd(), 'schemas/agent-result.schema.json'), command: fake })
    .run({ ...request, timeout_seconds: 30 }, { signal: cancellation.signal });
  let pid: number | undefined;
  try {
    for (let index = 0; index < 100; index++) {
      const value = await readFile(pidFile, 'utf8').catch(() => '');
      if (value) { pid = Number(value); break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (pid === undefined) throw new Error('fixture process did not start');
    cancellation.abort();
    const cancelled = await pending;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    results.push({ case: 'abort returns before process group exits',
      resultStatus: cancelled.status, summary: cancelled.summary, processStillAlive: alive });
  } finally {
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
  }
}

const outputPath = join(process.cwd(), 'docs/reviews/2026-10-28-global-audit-extra-results.json');
await writeFile(outputPath, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
