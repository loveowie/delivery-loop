# Delivery Loop Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Do not run Git write commands without explicit user approval.

**Goal:** Build a Codex plugin that runs a generic, resumable, multi-agent software-delivery loop from an approved specification through implementation, verification, review, acceptance, and a reviewable delivery artifact.

**Architecture:** A thin MCP gateway exposes `delivery_*` tools. A deterministic TypeScript controller persists a task DAG, selects ready tasks, launches isolated Codex workers through adapters, runs verification commands, converts failures and review findings into new tasks, and only completes when the acceptance matrix passes. Generic Skills are vendored and resolved by hash; OpenSpec and project-specific Skills remain optional.

**Tech Stack:** Node.js 24, TypeScript, `@modelcontextprotocol/sdk`, Zod, Node test runner through `tsx`, JSON/JSONL state, Git worktree commands through a guarded adapter.

**Spec:** `docs/design/codex-end-to-end-delivery-plugin-design.md`

## Global Constraints

- Default profile is `portable` with `spec.provider: native`.
- The plugin core must not depend on OpenSpec CLI or a business-domain Skill.
- OpenSpec is enabled only through an explicit Provider and version preflight.
- The plugin must not run `git commit`, `git push`, `git merge`, or `git init` without explicit user approval.
- Existing worker work must happen in isolated worktrees when a Git adapter is enabled.
- Worker completion is a claim; only coordinator verification can mark a task `DONE`.
- All state and reports live under the target repository `.delivery/`, excluding Git snapshots and patches.
- Skill files are resolved from plugin-owned paths and validated by SHA-256.
- Tests are written before production code and each cycle records a failing then passing run.

---

## Task 1: Project scaffolding and plugin metadata

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.codex-plugin/plugin.json`
- Create: `.mcp.json`
- Create: `scripts/launch_delivery_mcp`
- Create: `README.md`

**Interfaces:**
- Produces: npm scripts `build`, `test`, `test:watch`, `typecheck`, `start`.
- Produces: plugin manifest name `delivery-loop` and MCP server name `delivery_loop`.

- [x] **Step 1: Write a manifest smoke test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('plugin manifest exposes skills and MCP server', async () => {
  const manifest = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'));
  assert.equal(manifest.name, 'delivery-loop');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/manifest.test.ts`
Expected: FAIL because the manifest does not exist.

- [x] **Step 3: Create the scaffold and manifest**

Write the package files, plugin manifest, MCP launcher and README. The MCP launcher must locate `node` through `CODEX_MCP_NODE_PATH` first and refuse an unsupported Node version.

- [x] **Step 4: Run the smoke test and verify GREEN**

Run: `npm test -- tests/manifest.test.ts`
Expected: PASS.

## Task 2: Configuration and domain schemas

**Files:**
- Create: `src/config/config.ts`
- Create: `src/domain/types.ts`
- Create: `src/domain/schemas.ts`
- Create: `schemas/delivery-config.schema.json`
- Create: `schemas/task.schema.json`
- Create: `schemas/agent-request.schema.json`
- Create: `schemas/agent-result.schema.json`
- Test: `tests/config/config.test.ts`
- Test: `tests/domain/schemas.test.ts`

**Interfaces:**
- Produces: `loadConfig(repoRoot: string, override?: Partial<DeliveryConfig>): Promise<DeliveryConfig>`
- Produces: `validateTaskGraph(graph: TaskGraph): ValidationResult`
- Produces: `DeliveryConfig`, `RunState`, `TaskNode`, `AgentRequest`, `AgentResult`.

Key test cases:

```ts
test('portable config defaults to native provider and no external project skills', async () => {
  const config = await loadConfig('/tmp/repo');
  assert.equal(config.profile, 'portable');
  assert.equal(config.spec.provider, 'native');
  assert.deepEqual(config.capabilities.project_skills, []);
});

test('rejects cyclic task dependencies', () => {
  const result = validateTaskGraph(graphWithCycle());
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /cycle/i);
});
```

- [x] **Step 1: Write both failing tests.**
- [x] **Step 2: Run `npm test -- tests/config/config.test.ts tests/domain/schemas.test.ts` and verify RED.**
- [x] **Step 3: Implement config merging, Zod schemas and DAG validation.**
- [x] **Step 4: Run the targeted tests and verify GREEN.**

## Task 3: State store, snapshots and repository context

**Files:**
- Create: `src/state/state-store.ts`
- Create: `src/state/run-service.ts`
- Create: `src/workspace/repository-context.ts`
- Create: `src/workspace/snapshot.ts`
- Test: `tests/state/state-store.test.ts`
- Test: `tests/workspace/snapshot.test.ts`

**Interfaces:**
- Produces: `StateStore.createRun()`, `StateStore.readRun()`, `StateStore.updateRun()`, `StateStore.appendEvent()`.
- Produces: `getRepositoryContext(workdir: string): Promise<RepositoryContext>`.
- Produces: `createCodeSnapshot(workdir: string, baseline: string): Promise<CodeSnapshot>`.

Key behavior:

```ts
test('reloads the latest atomically written run state', async () => {
  const store = await StateStore.open(tempRepo);
  const created = await store.createRun(initialRun());
  await store.updateRun(created.run_id, { status: 'RUNNING' });
  const loaded = await store.readRun(created.run_id);
  assert.equal(loaded?.status, 'RUNNING');
});

test('excludes delivery runtime files from snapshots', async () => {
  const snapshot = await createCodeSnapshot(repo, baseline);
  assert.equal(snapshot.untracked_files.includes('.delivery/runs/x/state.json'), false);
});
```

- [x] **Step 1: Write the tests and verify RED.**
- [x] **Step 2: Implement repository resolution, atomic writes and JSONL events.**
- [x] **Step 3: Implement snapshot hashing with `.delivery/` exclusions.**
- [x] **Step 4: Run the targeted tests and verify GREEN.**

## Task 4: Deterministic scheduler and state transitions

**Files:**
- Create: `src/scheduler/state-machine.ts`
- Create: `src/scheduler/scheduler.ts`
- Create: `src/scheduler/failure-fingerprint.ts`
- Test: `tests/scheduler/state-machine.test.ts`
- Test: `tests/scheduler/scheduler.test.ts`

**Interfaces:**
- Produces: `assertRunTransition(from, to)`, `assertTaskTransition(from, to)`.
- Produces: `selectReadyTasks(graph, options): TaskNode[]`.
- Produces: `failureFingerprint(input): string`.

Key behavior:

```ts
test('downstream task remains pending until dependency is integrated', () => {
  const graph = dependencyGraph({ upstream: 'VERIFYING', downstream: 'PENDING' });
  assert.deepEqual(selectReadyTasks(graph, defaults), []);
});

test('disjoint ready tasks respect the worker limit', () => {
  const graph = readyGraph(3);
  assert.equal(selectReadyTasks(graph, { maxWorkers: 2 }).length, 2);
});
```

- [x] **Step 1: Write state transition and DAG scheduling tests; verify RED.**
- [x] **Step 2: Implement allowed transition tables and scheduler selection.**
- [x] **Step 3: Implement stable failure fingerprints and duplicate suppression.**
- [x] **Step 4: Run the targeted tests and verify GREEN.**

## Task 5: Vendored capability resolver

**Files:**
- Create: `src/capabilities/skill-resolver.ts`
- Create: `capabilities/profiles.yaml`
- Create: `capabilities/role-skills.yaml`
- Create: `capabilities/skills.lock.yaml`
- Create: `capabilities/THIRD_PARTY_LICENSES/README.md`
- Create: `skills/deliver-change/SKILL.md`
- Create: `skills/deliver-change/agents/openai.yaml`
- Copy: selected MIT-licensed Skill content under `capabilities/vendors/`
- Test: `tests/capabilities/skill-resolver.test.ts`

**Interfaces:**
- Produces: `SkillResolver.resolve(profile, role, projectSkills): ResolvedSkill[]`.
- Produces: `SkillResolver.verify(resolvedSkill): Promise<void>`.
- Produces: `SkillResolver.snapshotForRun(runId, resolvedSkills): Promise<string>`.

Key behavior:

```ts
test('rejects hash mismatch before a worker starts', async () => {
  const resolver = await SkillResolver.open(pluginRoot, lockFile);
  await assert.rejects(resolver.verify({ ...skill, sha256: 'bad' }), /hash/i);
});

test('portable profile does not resolve OpenSpec skills', async () => {
  const skills = await resolver.resolve('portable', 'implementer', []);
  assert.equal(skills.some((skill) => skill.id.includes('openspec')), false);
});
```

- [x] **Step 1: Write resolver tests and verify RED.**
- [x] **Step 2: Implement lock-file parsing, hash verification and role resolution.**
- [x] **Step 3: Vendor only generic MIT-licensed workflow Skills and preserve licenses.**
- [x] **Step 4: Implement run-level runtime Skill snapshots.**
- [x] **Step 5: Run the targeted tests and verify GREEN.**

## Task 6: Worker adapter and verification runner

**Files:**
- Create: `src/workers/worker-adapter.ts`
- Create: `src/workers/codex-exec-adapter.ts`
- Create: `src/workers/fake-adapter.ts`
- Create: `src/verification/command-runner.ts`
- Create: `src/verification/evidence-store.ts`
- Test: `tests/workers/codex-exec-adapter.test.ts`
- Test: `tests/verification/command-runner.test.ts`

**Interfaces:**
- Produces: `WorkerAdapter.run(request: AgentRequest): Promise<AgentResult>`.
- Produces: `CommandRunner.run(request: VerificationRequest): Promise<EvidenceRecord>`.
- `CodexExecAdapter` builds a non-recursive `codex exec` command with JSONL, output schema and `-C` worktree path.

Key behavior:

```ts
test('codex worker command cannot recursively start delivery and prefers workspace write', () => {
  const args = buildCodexExecArgs(agentRequest());
  assert.ok(args.includes('workspace-write'));
  assert.match(args.join(' '), /不得递归创建交付/);
});

test('command evidence captures a nonzero exit without throwing', async () => {
  const evidence = await runner.run({ command: 'node -e "process.exit(2)"', cwd: tempRepo });
  assert.equal(evidence.exit_code, 2);
  assert.equal(evidence.result, 'failed');
});
```

- [x] **Step 1: Write the adapter and runner tests; verify RED.**
- [x] **Step 2: Implement process execution, timeout, output capture and redaction.**
- [x] **Step 3: Implement the Codex adapter and fake adapter.**
- [x] **Step 4: Run the targeted tests and verify GREEN.**

## Task 7: Delivery controller loop

**Files:**
- Create: `src/controller/delivery-controller.ts`
- Create: `src/controller/acceptance.ts`
- Create: `src/controller/review-cycle.ts`
- Test: `tests/controller/delivery-controller.test.ts`
- Test: `tests/controller/acceptance.test.ts`

**Interfaces:**
- Produces: `DeliveryController.start(runId)`, `tick(runId)`, `pause(runId)`, `resume(runId)`, `cancel(runId)`.
- Consumes: state store, scheduler, worker adapter, verification runner and skill resolver.

Key behavior:

```ts
test('failed verification creates a bugfix task instead of completing the run', async () => {
  const controller = controllerWithFailure();
  await controller.start('run-1');
  const state = await controller.tick('run-1');
  assert.equal(state.status, 'RUNNING');
  assert.ok(state.graph.tasks.some((task) => task.origin === 'test_failure'));
});

test('manual acceptance blocks completion', async () => {
  const result = await evaluateAcceptance(graphWithManualAcceptance(), []);
  assert.equal(result.status, 'WAITING_HUMAN');
});
```

- [x] **Step 1: Write failing tests for verification failure, review findings, manual acceptance and completion.**
- [x] **Step 2: Implement the controller loop and dynamic task creation.**
- [x] **Step 3: Implement review findings and acceptance matrices.**
- [x] **Step 4: Run the targeted tests and verify GREEN.**

## Task 8: MCP gateway and tool contracts

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/tools.ts`
- Create: `src/index.ts`
- Test: `tests/mcp/tools.test.ts`

**Interfaces:**
- Produces tools: `delivery_start`, `delivery_status`, `delivery_watch`, `delivery_respond`, `delivery_pause`, `delivery_resume`, `delivery_cancel`, `delivery_export_report`, `delivery_finalize`.
- `delivery_finalize` must reject without explicit confirmation and explicit mode.

Key behavior:

```ts
test('status returns a bounded summary rather than full logs', async () => {
  const response = await tools.delivery_status({ run_id: 'run-1' });
  assert.equal('events' in response, false);
  assert.ok(response.recent_events.length <= 10);
});

test('finalize requires explicit confirmation', async () => {
  await assert.rejects(tools.delivery_finalize({ run_id: 'run-1', mode: 'commit' }), /confirm/i);
});
```

- [x] **Step 1: Write failing MCP tool contract tests.**
- [x] **Step 2: Implement Zod input schemas and stable summary responses.**
- [x] **Step 3: Wire `McpServer` to stdio transport in `src/index.ts`.**
- [x] **Step 4: Run unit tests and a local MCP initialize/list-tools smoke test.**

## Task 9: Patch integration and guarded Git operations

**Files:**
- Create: `src/workspace/patch-integrator.ts`
- Create: `src/workspace/git-adapter.ts`
- Test: `tests/workspace/patch-integrator.test.ts`
- Test: `tests/workspace/git-adapter.test.ts`

**Interfaces:**
- Produces: `PatchIntegrator.exportTaskPatch(taskWorktree, baseline): Promise<PatchArtifact>`.
- Produces: `PatchIntegrator.applyToIntegration(patch): Promise<IntegrationResult>`.
- Produces: `GitAdapter.assertNoWriteWithoutApproval(operation)`.

Tests use fake command executors unless the user explicitly authorizes temporary Git writes. The guarded adapter must reject `commit`, `push`, `merge`, and `init` by default.

```ts
test('git adapter rejects commit without approval token', async () => {
  await assert.rejects(git.run('commit', {}, null), /approval/i);
});
```

- [x] **Step 1: Write failing tests for patch export/apply command construction and Git guards.**
- [x] **Step 2: Implement patch generation including untracked files and binary diffs.**
- [x] **Step 3: Implement the approval-gated Git adapter.**
- [x] **Step 4: Run targeted tests and verify GREEN.**

## Task 10: Native reports, finalization and recovery

**Files:**
- Create: `src/reporting/report-writer.ts`
- Create: `src/controller/recovery.ts`
- Create: `src/finalize/finalizer.ts`
- Test: `tests/reporting/report-writer.test.ts`
- Test: `tests/controller/recovery.test.ts`

**Interfaces:**
- Produces: `writeDeliveryReport(run)`.
- Produces: `recoverInterruptedRun(runId)`.
- Produces: `finalizeRun(runId, { mode, confirmation })`.

Key behavior:

```ts
test('prepare-only completion never invokes commit or push', async () => {
  const finalizer = finalizerWithSpy();
  await finalizer.finalize('run-1', { mode: 'prepare-only', confirmation: 'run-1' });
  assert.equal(finalizer.executor.calls.some((call) => call.startsWith('git commit')), false);
});
```

- [x] **Step 1: Write failing tests for report, recovery and finalization.**
- [x] **Step 2: Implement report generation and run recovery.**
- [x] **Step 3: Implement finalization modes with explicit approval checks.**
- [x] **Step 4: Run targeted tests and verify GREEN.**

## Task 11: Documentation and evaluation fixtures

**Files:**
- Create: `README.md`
- Create: `docs/configuration.md`
- Create: `docs/operations.md`
- Create: `examples/portable/delivery.yaml`
- Create: `examples/portable/spec.md`
- Create: `examples/portable/task-graph.json`
- Create: `docs/evaluation.md`

The documentation must explain installation, portable/native defaults, optional OpenSpec setup, MCP tools, no-commit behavior, state recovery and the foreground fallback.

- [x] **Step 1: Add executable examples matching the final schemas.**
- [x] **Step 2: Validate JSON examples with the same Zod schemas used by the runtime.**
- [x] **Step 3: Run documentation link and command checks.**

## Task 12: Full verification and review

**Files:**
- Create: `docs/verification-report.md`
- Create: `docs/review-report.md`

- [x] **Step 1: Run `npm test` and record full pass/fail counts.**
- [x] **Step 2: Run `npm run typecheck`.**
- [x] **Step 3: Run `npm run build`.**
- [x] **Step 4: Run `npm pack --dry-run` and inspect the packaged file list.**
- [x] **Step 5: Run a fake-agent end-to-end delivery with a verifier failure and recovery.**
- [x] **Step 6: Run an independent review against the specification and source.**
- [x] **Step 7: Fix all confirmed review findings and rerun steps 1-5.**
- [x] **Step 8: Record evidence and unexecuted checks, including Git operations requiring approval.**

