import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
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

// Real Git: the default final review produces an empty delta.
{
  const f = await fixture(true);
  const first = await f.controller.tick('run-1');
  const second = await f.controller.tick('run-1');
  results.push({ case: 'default final review', repo: f.repo,
    first: first.graph.tasks.map(t => [t.id, t.status]),
    second: second.graph.tasks.map(t => [t.id, t.status]),
    error: (await f.store.readEvents('run-1')).filter(e => e.type === 'fix_required'),
    roles: f.requests.map(r => r.role) });
}

// Real Git: restarting a controller reuses the existing attempt path.
{
  const f = await fixture();
  await f.worktrees.prepare(f.state, f.state.graph.tasks[0]);
  await f.store.updateRun('run-1', s => { s.graph.tasks[0]!.status = 'RUNNING'; return s; });
  const recovered = await recoverInterruptedRun(f.store, 'run-1');
  let error = '';
  try { await f.worktrees.prepare(recovered, recovered.graph.tasks[0]!); }
  catch (e) { error = String(e); }
  results.push({ case: 'crash recovery existing worktree', status: recovered.graph.tasks[0]!.status,
    attempt: recovered.graph.tasks[0]!.attempt, error });
}

// Real Git: a failed pre-integration implementation is absent in the debugger worktree.
{
  let debuggerHasImplementation: boolean | undefined;
  const f = await fixture(false, async (r: any) => {
    if (r.role === 'implementer') await writeFile(join(r.workdir, 'src/feature.txt'), 'return 42\n');
    if (r.role === 'debugger') {
      debuggerHasImplementation = await access(join(r.workdir, 'src/feature.txt')).then(() => true, () => false);
    }
    return completed(r);
  });
  await f.store.updateRun('run-1', s => { s.graph.tasks[0]!.verification_commands = ['node -e "process.exit(1)"']; return s; });
  await f.controller.tick('run-1');
  await f.controller.tick('run-1');
  results.push({ case: 'repair loses failed implementation and context', debuggerHasImplementation,
    requests: f.requests.map(r => ({ role: r.role, objective: r.objective,
      context_files: r.context_files, keys: Object.keys(r) })) });
}

// Real Git: exporting a patch changes the index after snapshot capture.
{
  const f = await fixture(false, async (r: any) => {
    await writeFile(join(r.workdir, 'src/new.txt'), 'new file\n');
    return completed(r);
  });
  const done = await f.controller.tick('run-1');
  const actual = await createCodeSnapshot(done.integration_worktree!);
  results.push({ case: 'snapshot changes during integration export', status: done.status,
    persistedSnapshot: done.integration_snapshot_id, actualSnapshot: actual.id,
    equal: done.integration_snapshot_id === actual.id,
    statusPorcelain: await git(done.integration_worktree!, ['status', '--porcelain']) });
}

// The queue includes queued runs as active, so neither can wake after the owner completes.
{
  const f = await fixture();
  const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'delivery-audit-registry-')));
  const manager = new DeliveryRunManager({ pluginRoot: process.cwd(), runtimeFactory: {} as any,
    registry, workerLauncher: async () => {} });
  for (const id of ['run-2', 'run-3']) {
    await f.store.createRun({ ...structuredClone(f.state), run_id: id, status: 'QUEUED' });
  }
  await f.store.updateRun('run-1', s => ({ ...s, status: 'COMPLETED' }));
  const states = [];
  for (const id of ['run-2', 'run-3']) {
    const handle: any = { state: await f.store.readRun(id), store: f.store, repoRoot: f.repo,
      controller: f.controller, evidenceLedger: new EvidenceLedger(f.repo) };
    await manager.wake(handle);
    states.push([id, (await f.store.readRun(id))?.status]);
  }
  results.push({ case: 'queue deadlock with no running owner', states });
}

// A fabricated initially-DONE task passes graph validation and can satisfy a requirement.
{
  const graph: any = { run_id: 'r', tasks: [{ ...task(), status: 'DONE', requirement_ids: ['REQ-1'] }],
    requirements: [{ id: 'REQ-1', description: 'Important feature', status: 'PENDING' }], acceptance: [] };
  results.push({ case: 'acceptance without evidence', graphValidation: validateTaskGraph(graph),
    acceptance: evaluateAcceptance(graph, [], 'SNAP-NO-EVIDENCE') });
}

// Verification commands have host write access beyond their worktree.
{
  const f = await fixture();
  const external = await mkdtemp(join(tmpdir(), 'delivery-audit-outside-'));
  const marker = join(external, 'marker.txt');
  const command = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "outside write")'`;
  const evidence = await new CommandRunner(f.repo).run({ run_id: 'run-1', task_id: 'T',
    acceptance_ids: [], code_snapshot_id: 'S', command, cwd: f.repo, timeout_seconds: 5 });
  results.push({ case: 'verification writes outside workspace', result: evidence.result,
    outsideFile: await readFile(marker, 'utf8') });
}

// Failed workers consume tokens, but return before accounting.
{
  const f = await fixture(false, async (r: any) => completed(r,
    { status: 'failed', summary: 'process failed after consuming tokens', token_usage: 100 }));
  await f.store.updateRun('run-1', s => {
    s.config.runtime.max_total_tokens = 50;
    return s;
  });
  await f.controller.tick('run-1');
  const state = await f.controller.tick('run-1');
  results.push({ case: 'failed worker token budget bypass', actualReportedTokens: 200,
    persistedTokens: state.total_tokens_used ?? 0, budget: state.config.runtime.max_total_tokens,
    runStatus: state.status, taskAttempt: state.graph.tasks[0]!.attempt });
}

// A human answer resets a task without changing its attempt or sending the answer.
{
  let calls = 0;
  const f = await fixture(false, async (r: any) => {
    calls++;
    return completed(r, calls === 1 ? { status: 'blocked', blockers: [{
      decision_id: 'D1', type: 'requirement', question: 'Choose response value?',
      options: ['42', '7'], affected_task_ids: [r.task_id],
    }] } : {});
  });
  await f.controller.tick('run-1');
  const waiting = await f.store.readRun('run-1');
  await f.controller.respond('run-1', 'D1', '42');
  let error = '';
  try { await f.controller.tick('run-1'); } catch(e) { error = String(e); }
  results.push({ case: 'human decision resume', pendingStateKeys: Object.keys(waiting!),
    workerCalls: calls, error });
}

// Per-task acceptance commands are not rerun for the final integration snapshot.
{
  const f = await fixture(false, async (r: any) => {
    if (r.task_id === 'TASK-1') await writeFile(join(r.workdir, 'src/one.txt'), 'one\n');
    else await writeFile(join(r.workdir, 'src/two.txt'), `two-${r.task_id}\n`);
    return completed(r);
  });
  const command = 'node -e "process.exit(0)"';
  await f.store.updateRun('run-1', s => {
    s.graph.requirements = [{ id: 'REQ-1', description: 'one', status: 'PENDING' }];
    s.graph.acceptance = [{ id: 'AC-1', requirement_id: 'REQ-1', description: 'one passes',
      mandatory: true, risk: 'low', verification: { type: 'command', command, expected_exit_code: 0 } }];
    s.graph.tasks[0]!.requirement_ids = ['REQ-1'];
    s.graph.tasks[0]!.acceptance_ids = ['AC-1'];
    s.graph.tasks[0]!.verification_commands = [command];
    s.graph.tasks.push({ ...task('TASK-2'), depends_on: ['TASK-1'] });
    return s;
  });
  await f.controller.tick('run-1');
  const state = await f.controller.tick('run-1');
  const fixes = state.graph.tasks.filter(t => t.origin === 'acceptance_gap');
  results.push({ case: 'per-task acceptance invalidated without rerun', runStatus: state.status,
    fixTasks: fixes.map(t => ({ id: t.id, acceptance_ids: t.acceptance_ids,
      verification_commands: t.verification_commands, title: t.title })),
    evidence: (await new EvidenceLedger(f.repo).readAll('run-1')).map(e =>
      ({ task_id: e.task_id, command: e.command, snapshot: e.code_snapshot_id })),
    finalSnapshot: state.integration_snapshot_id });
}

const output = await mkdtemp(join(tmpdir(), 'delivery-loop-audit-results-'));
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log('Evidence directory:', output);
console.log(JSON.stringify(results, null, 2));
