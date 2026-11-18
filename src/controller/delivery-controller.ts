import { changedSnapshotPaths } from '../workspace/repository-context.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeDeliveryReport } from '../reporting/report-writer.js';
import { compileVerificationPlan } from './verification-planner.js';
import { evaluateAcceptance, acceptedContentSnapshotId, NO_ACCEPTED_SNAPSHOT } from './acceptance.js';
import { blockingFindings } from './review-cycle.js';
import { failureFingerprint } from '../scheduler/failure-fingerprint.js';
import { durationExceeded } from '../runtime/loop-guards.js';
import { promotePendingTasks, selectReadyTasks } from '../scheduler/scheduler.js';
import { assertRunTransition, assertTaskTransition } from '../scheduler/state-machine.js';
import { StateStore } from '../state/state-store.js';
import { EvidenceLedger } from '../state/evidence-ledger.js';
import type {
  AgentRequest,
  AgentResult,
  CodeSnapshot,
  EvidenceRecord,
  RunState,
  RunStatus,
  TaskNode,
  TaskStatus,
  WorkerRole,
} from '../domain/types.js';
import type { ResolvedSkill } from '../capabilities/skill-resolver.js';
import type { WorkerAdapter } from '../workers/worker-adapter.js';
import type { VerificationRequest } from '../verification/command-runner.js';
import { validateTaskGraph } from '../domain/schemas.js';
import { validateDeliveryContract } from '../domain/contract.js';
import { missingRequiredOutputs } from './required-outputs.js';
import { recordDecision } from './decision-journal.js';

export interface SkillProvider {
  resolve(
    profile: TaskNode['capability_profile'],
    role: string,
    projectSkills: string[],
    projectRoot?: string,
  ): Promise<ResolvedSkill[]>;
  verifyAll(skills: ResolvedSkill[]): Promise<void>;
}

export interface TaskWorkspace {
  path: string;
  cleanup(): Promise<void>;
}

export interface WorktreeProvider {
  prepare(state: RunState, task: TaskNode, seedFromWorktree?: string): Promise<TaskWorkspace>;
}

export interface SnapshotProvider {
  create(workdir: string, baselineCommit: string): Promise<CodeSnapshot>;
  changedFiles?(workdir: string): Promise<string[]>;
}

export interface VerificationRunner {
  run(request: VerificationRequest): Promise<EvidenceRecord>;
}

export interface IntegrationResult {
  ok: boolean;
  error?: string;
  workdir?: string;
  snapshot_id?: string;
  artifact?: { path: string; sha256: string };
}

export interface Integrator {
  integrate(state: RunState, task: TaskNode, workdir: string, snapshot: CodeSnapshot): Promise<IntegrationResult>;
}

export interface DeliveryControllerOptions {
  repoRoot: string;
  store: StateStore;
  workers: WorkerAdapter;
  skills: SkillProvider;
  worktrees: WorktreeProvider;
  snapshots: SnapshotProvider;
  verifier: VerificationRunner;
  integrator: Integrator;
  evidenceLedger?: EvidenceLedger;
}

function roleForTask(task: TaskNode): WorkerRole {
  return task.worker_role;
}

/** Task states that may still be persisted when a controller dies mid-tick. */
const IN_FLIGHT_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'RUNNING',
  'VERIFYING',
  'REVIEWING',
  'INTEGRATING',
]);

function taskRequiresReview(task: TaskNode, config: RunState['config']): boolean {
  if (task.worker_role === 'reviewer' || task.worker_role === 'acceptance') {
    return false;
  }
  if (config.review.task_review_policy === 'always') {
    return true;
  }
  if (task.review_policy === 'none') {
    return false;
  }
  if (config.review.task_review_policy === 'batch') {
    return false;
  }
  if (task.review_policy === 'required') {
    return true;
  }
  return task.review_policy === 'risk-based' && ['high', 'critical'].includes(task.risk);
}

function normalizeBlockers(
  taskId: string,
  summary: string,
  blockers: AgentResult['blockers'],
): AgentResult['blockers'] {
  const valid = blockers
    .filter((blocker) => typeof blocker.decision_id === 'string' && blocker.decision_id.length > 0)
    .map((blocker) => ({
      ...blocker,
      // The reporting task is always affected by its own blocker. Without this,
      // a worker that names only downstream tasks leaves itself stuck in
      // INTERRUPTED forever: `respond` only requeues the mapped tasks.
      affected_task_ids: [...new Set([taskId, ...blocker.affected_task_ids])],
    }));
  if (valid.length > 0) {
    return valid;
  }
  // A blocked worker that supplies no structured decision would otherwise put
  // the run into WAITING_HUMAN with no answerable decision at all. Synthesize a
  // decision from its summary so a human always has a way forward.
  const decisionId = `BLOCKED-${taskId}-${createHash('sha256').update(summary).digest('hex').slice(0, 8)}`;
  return [{
    decision_id: decisionId,
    type: 'requirement',
    question: `Worker 报告阻塞：${summary || '未提供原因'}。请提供处理意见后重新调度该任务。`,
    options: ['retry', 'cancel'],
    affected_task_ids: [taskId],
  }];
}

function changeTask(state: RunState, taskId: string, status: TaskStatus): void {
  const task = state.graph.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    throw new Error(`unknown task: ${taskId}`);
  }
  assertTaskTransition(task.status, status);
  task.status = status;
}

function changeRun(state: RunState, status: RunStatus): void {
  if (state.status === status) {
    return;
  }
  assertRunTransition(state.status, status);
  state.status = status;
}

function createFixTask(
  state: RunState,
  origin: TaskNode['origin'],
  source: TaskNode,
  failureKey: string,
): TaskNode {
  const taskId = `FIX-${createHash('sha256').update(failureKey).digest('hex').slice(0, 10)}`;
  const existing = state.graph.tasks.find(
    (candidate) =>
      candidate.id === taskId && !['DONE', 'CANCELLED'].includes(candidate.status),
  );
  if (existing !== undefined) {
    return existing;
  }
  let uniqueTaskId = taskId;
  let suffix = 2;
  while (state.graph.tasks.some((candidate) => candidate.id === uniqueTaskId)) {
    uniqueTaskId = `${taskId}-${suffix}`;
    suffix += 1;
  }
  const fix: TaskNode = {
    ...structuredClone(source),
    id: uniqueTaskId,
    type: origin === 'review_finding' ? 'review_fix' : 'bugfix',
    status: 'READY',
    origin,
    depends_on: [],
    worker_role: origin === 'review_finding' ? 'implementer' : 'debugger',
    attempt: 0,
    required_outputs: [],
    last_failure_fingerprint: failureKey,
  };
  if (source.status === 'FIX_REQUIRED') {
    fix.repairs_task_id = source.id;
  }
  fix.dynamic_depth = (source.dynamic_depth ?? 0) + 1;
  state.graph.tasks.push(fix);
  return fix;
}

const APPROVAL_RESPONSES = new Set([
  'approve', 'approved', 'yes', 'confirm', 'confirmed', '通过', '确认', '同意', '验收通过', '已通过',
]);

function isApprovalResponse(response: string): boolean {
  return APPROVAL_RESPONSES.has(response.trim().toLowerCase());
}

function uniqueTaskId(state: RunState, base: string): string {
  let candidate = base;
  let suffix = 2;
  while (state.graph.tasks.some((task) => task.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Turn a rejected manual acceptance into an actionable repair task instead of
 * leaving the run waiting with no way to rework the deliverable.
 */
function createManualAcceptanceRepair(
  state: RunState,
  conditionId: string,
  feedback: string,
): { task?: TaskNode; exhausted?: string } {
  const condition = (state.graph.acceptance ?? []).find((candidate) => candidate.id === conditionId);
  if (condition === undefined) {
    return { exhausted: `unknown manual acceptance condition: ${conditionId}` };
  }
  const sources = state.graph.tasks.filter(
    (task) => task.status === 'DONE' && task.requirement_ids.includes(condition.requirement_id),
  );
  const depth = sources.reduce((maximum, task) => Math.max(maximum, task.dynamic_depth ?? 0), 0);
  if (depth >= state.config.runtime.max_dynamic_depth) {
    return { exhausted: 'dynamic task depth exhausted for manual acceptance repair' };
  }
  const hash = createHash('sha256')
    .update(`${state.run_id}:${conditionId}:${feedback}:${state.graph.tasks.length}`)
    .digest('hex')
    .slice(0, 10);
  const id = uniqueTaskId(state, `FIX-${hash}`);
  const task: TaskNode = {
    id,
    type: 'review_fix',
    title: `修复人工验收问题：${conditionId}`,
    status: 'READY',
    priority: 'high',
    risk: 'high',
    origin: 'acceptance_gap',
    depends_on: [],
    requirement_ids: [condition.requirement_id],
    acceptance_ids: [conditionId],
    scope_paths: [...new Set(sources.flatMap((source) => source.scope_paths))],
    required_outputs: [],
    worker_role: 'implementer',
    capability_profile: state.config.profile,
    attempt: 0,
    max_attempts: state.config.runtime.max_task_attempts,
    verification_commands: [...new Set(sources.flatMap((source) => source.verification_commands))],
    review_policy: 'risk-based',
    dynamic_depth: depth + 1,
    ...(sources[0] === undefined ? {} : { repairs_task_id: sources[0].id }),
    ...(state.integration_worktree === undefined ? {} : { seed_worktree: state.integration_worktree }),
    failure_context: { summary: `人工验收未通过：${feedback}` },
  };
  return { task };
}

export class DeliveryController {
  private readonly options: DeliveryControllerOptions;
  private evidence: EvidenceRecord[] = [];
  private readonly evidenceLedger?: EvidenceLedger;
  private readonly stateLocks = new Map<string, Promise<void>>();
  private readonly integrationLocks = new Map<string, Promise<void>>();
  private readonly cancellationControllers = new Map<string, Set<AbortController>>();
  private readonly activeOperations = new Map<string, Set<Promise<unknown>>>();

  constructor(options: DeliveryControllerOptions) {
    this.options = options;
    if (options.evidenceLedger !== undefined) {
      this.evidenceLedger = options.evidenceLedger;
    }
  }

  private async requireRun(runId: string): Promise<RunState> {
    const state = await this.options.store.readRun(runId);
    if (state === undefined) {
      throw new Error(`run not found: ${runId}`);
    }
    return state;
  }

  async start(runId: string): Promise<RunState> {
    const current = await this.requireRun(runId);
    if (['COMPLETED', 'CANCELLED'].includes(current.status)) return current;
    const validation = validateTaskGraph(current.graph);
    if (!validation.ok) {
      throw new Error(`invalid task graph: ${validation.errors.join('; ')}`);
    }
    const contractErrors = validateDeliveryContract(current.graph, current.config);
    if (contractErrors.length > 0) {
      throw new Error(`invalid delivery contract: ${contractErrors.join('; ')}`);
    }
    let state = current;
    if (
      current.config.verification.baseline &&
      current.baseline_verification_id === undefined
    ) {
      const baselineId = `BASELINE-${(current.baseline_commit ?? 'HEAD').slice(0, 12)}`;
      const commands = [
        ...current.config.verification.commands.build,
        ...current.config.verification.commands.test,
        ...current.config.verification.commands.lint,
        ...current.config.verification.commands.e2e,
      ];
      if (commands.length > 0) {
        await recordDecision(this.options.store, {
          run_id: runId,
          phase: 'prepare',
          code: 'baseline_started',
          title: `开始基线验证（${commands.length} 条命令）`,
          outcome: 'info',
          data: { commands },
        });
      }
      const failedBaselineCommands: string[] = [];
      for (const command of commands) {
        const evidence = await this.runVerification({
          run_id: runId,
          task_id: 'BASELINE',
          acceptance_ids: [],
          code_snapshot_id: baselineId,
          command,
          cwd: current.repo_root,
          timeout_seconds: current.config.runtime.default_worker_timeout_seconds,
          baseline_id: baselineId,
        });
        this.evidence.push(evidence);
        await this.evidenceLedger?.append(evidence);
        const latest = await this.requireRun(runId);
        if (latest.status === 'CANCELLED') return latest;
        if (evidence.result === 'error') {
          await recordDecision(this.options.store, {
            run_id: runId,
            phase: 'prepare',
            code: 'baseline_error',
            title: '基线验证执行错误，运行已阻塞',
            detail: evidence.command,
            outcome: 'blocked',
            data: { evidence_id: evidence.id, command: evidence.command },
          });
          return await this.blockVerificationError(latest, evidence);
        }
        if (evidence.result === 'failed') {
          failedBaselineCommands.push(command);
          await recordDecision(this.options.store, {
            run_id: runId,
            phase: 'prepare',
            code: 'baseline_failed',
            title: `基线命令失败：${evidence.command}`,
            detail: '基线失败不阻塞启动；失败信息会作为后续任务的上下文。',
            outcome: 'fail',
            data: { evidence_id: evidence.id, command: evidence.command, exit_code: evidence.exit_code },
          });
        }
      }
      if (commands.length > 0) {
        await recordDecision(this.options.store, {
          run_id: runId,
          phase: 'prepare',
          code: 'baseline_passed',
          title: '基线验证完成',
          outcome: 'pass',
          data: { baseline_id: baselineId, commands: commands.length },
        });
      }
      state = {
        ...current,
        baseline_verification_id: baselineId,
        baseline_failures: failedBaselineCommands,
      };
    }
    state = await this.updateRun(runId, (draft) => {
      if (draft.status === 'CANCELLED') return draft;
      changeRun(draft, 'RUNNING');
      if (state.baseline_verification_id !== undefined) {
        draft.baseline_verification_id = state.baseline_verification_id;
        draft.baseline_failures = state.baseline_failures ?? [];
      }
      return draft;
    });
    await this.options.store.appendEvent(runId, { type: 'run_started' });
    await recordDecision(this.options.store, {
      run_id: runId,
      phase: 'lifecycle',
      code: 'run_started',
      title: '交付运行开始执行',
      detail: `共 ${state.graph.tasks.length} 个任务，最大并行 ${state.config.runtime.max_parallel_workers} 个 Worker。`,
      outcome: 'info',
      data: {
        baseline_commit: state.baseline_commit ?? null,
        git_mode: state.config.git.mode,
        profile: state.config.profile,
      },
    });
    return state;
  }

  async tick(runId: string): Promise<RunState> {
    let state = await this.requireRun(runId);
    if (['COMPLETED', 'CANCELLED', 'PAUSED', 'WAITING_HUMAN', 'BLOCKED', 'QUEUED'].includes(state.status)) {
      return state;
    }
    if (state.pause_requested) {
      state = await this.updateRun(runId, (draft) => {
        changeRun(draft, 'PAUSED');
        return draft;
      });
      await recordDecision(this.options.store, {
        run_id: runId,
        phase: 'lifecycle',
        code: 'run_paused',
        title: '运行已暂停',
        detail: '当前没有新的任务被调度，恢复后从持久化状态继续。',
        outcome: 'info',
      });
      return state;
    }

    state = await this.updateRun(runId, (draft) => {
      promotePendingTasks(draft.graph);
      return draft;
    });
    const ready = selectReadyTasks(state.graph, {
      maxWorkers: state.config.runtime.max_parallel_workers,
    });
    await Promise.all(ready.map(async (task) => await this.runTask(state, task.id)));
    state = (await this.options.store.readRun(runId)) ?? state;

    const current = state.graph.tasks.find((task) => task.id === ready[0]?.id);
    if (ready.length === 0 && ['RUNNING', 'VERIFYING'].includes(state.status)) {
      state = await this.finishOrContinueAcceptance(state);
    } else if (state.status === 'RUNNING' && current?.status === 'DONE') {
      const complete = state.graph.tasks.every(
        (task) => task.status === 'DONE' || task.status === 'CANCELLED',
      );
      if (complete) {
        state = await this.finishOrContinueAcceptance(state);
      }
    }
    return state;
  }

  private async updateRun(
    runId: string,
    update: (draft: RunState) => RunState,
    allowCancelled = false,
  ): Promise<RunState> {
    return await this.withKeyLock(this.stateLocks, runId, async () =>
      this.options.store.updateRun(runId, draft => draft.status === 'CANCELLED' && !allowCancelled ? draft : update(draft)),
    );
  }

  private async withKeyLock<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate, () => gate);
    locks.set(key, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === queued) {
        locks.delete(key);
      }
    }
  }

  private async resolveSkills(
    task: TaskNode,
    role: WorkerRole,
    state: RunState,
  ): Promise<ResolvedSkill[]> {
    const skills = await this.options.skills.resolve(
      task.capability_profile,
      role,
      state.config.capabilities.project_skills,
      state.repo_root,
    );
    await this.options.skills.verifyAll(skills);
    return skills;
  }

  private async runTask(initial: RunState, taskId: string): Promise<RunState> {
    let state = await this.updateRun(initial.run_id, (draft) => {
      changeTask(draft, taskId, 'RUNNING');
      draft.current_task_ids = [...new Set([...draft.current_task_ids, taskId])];
      return draft;
    });
    const task = state.graph.tasks.find((candidate) => candidate.id === taskId)!;
    await recordDecision(this.options.store, {
      run_id: state.run_id,
      phase: 'dispatch',
      code: 'task_started',
      title: `开始任务 ${taskId}`,
      detail: `${task.title}（角色：${task.worker_role}，第 ${task.attempt + 1} 次尝试）`,
      outcome: 'info',
      task_id: taskId,
      data: {
        type: task.type,
        role: task.worker_role,
        risk: task.risk,
        scope_paths: task.scope_paths,
        depends_on: task.depends_on,
      },
    });
    const beforePrepareCancelled = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
    if (beforePrepareCancelled !== undefined) return beforePrepareCancelled;
    let workspace: TaskWorkspace;
    try {
      workspace = await this.options.worktrees.prepare(
        state,
        task,
        task.seed_worktree ?? state.integration_worktree,
      );
    } catch (error) {
      return await this.blockTaskForViolation(
        state,
        taskId,
        `worktree preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let snapshot = await this.options.snapshots.create(
      workspace.path,
      state.baseline_commit ?? 'HEAD',
    );
    state = await this.updateRun(state.run_id, (draft) => {
      const draftTask = draft.graph.tasks.find((candidate) => candidate.id === taskId)!;
      draftTask.code_snapshot_id = snapshot.id;
      draftTask.workspace_path = workspace.path;
      return draft;
    });

    const skills = await this.resolveSkills(task, roleForTask(task), state);
    const initialSnapshot = snapshot;
    const initialSnapshotId = snapshot.id;
    const request = await this.agentRequest(state, task, skills, workspace.path);
    const result = await this.runWorkerWithCancellation(state.run_id, request);
    state = await this.accountUsage(state.run_id, result.token_usage);
    if (result.task_id !== taskId) {
      return await this.blockTaskForViolation(state, taskId, `worker returned wrong task_id: ${result.task_id}`);
    }
    if ((state.total_tokens_used ?? 0) > state.config.runtime.max_total_tokens) {
      return await this.blockTaskForViolation(state, taskId, `token budget exceeded: ${state.total_tokens_used}`);
    }
    if (result.status === 'completed') {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'execute',
        code: 'worker_completed',
        title: `Worker 提交结果：${taskId}`,
        detail: result.summary,
        outcome: 'pass',
        task_id: taskId,
        data: {
          files_changed: result.files_changed.slice(0, 100),
          findings: result.findings.length,
          token_usage: result.token_usage ?? null,
        },
      });
    } else if (result.status === 'failed') {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'execute',
        code: 'worker_failed',
        title: `Worker 执行失败：${taskId}`,
        detail: result.summary,
        outcome: 'fail',
        task_id: taskId,
      });
    }
    const cancelledAfterWorker = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
    if (cancelledAfterWorker !== undefined) {
      return cancelledAfterWorker;
    }
    if (result.status === 'blocked') {
      const blockers = normalizeBlockers(taskId, result.summary, result.blockers);
      state = await this.updateRun(state.run_id, (draft) => {
        draft.pending_decision_ids = [...new Set([...draft.pending_decision_ids, ...blockers.map((blocker) => blocker.decision_id)])];
        draft.decision_blockers = [...(draft.decision_blockers ?? []), ...blockers];
        draft.pending_decision_tasks ??= {};
        for (const blocker of blockers) {
          draft.pending_decision_tasks[blocker.decision_id] = blocker.affected_task_ids;
        }
        changeTask(draft, taskId, 'INTERRUPTED');
        draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
        changeRun(draft, 'WAITING_HUMAN');
        return draft;
      });
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'human',
        code: 'decision_required',
        title: `等待人工决策：${taskId}`,
        detail: result.summary,
        outcome: 'waiting',
        task_id: taskId,
        data: { blockers },
      });
      return state;
    }
    if (result.status === 'failed') {
      state = await this.retryInterruptedTask(state, taskId, result.summary);
      return state;
    }

    snapshot = await this.options.snapshots.create(
      workspace.path,
      state.baseline_commit ?? snapshot.baseline_commit,
    );
    state = await this.updateRun(state.run_id, (draft) => {
      const draftTask = draft.graph.tasks.find((candidate) => candidate.id === taskId)!;
      draftTask.code_snapshot_id = snapshot.id;
      return draft;
    });
    const changedFiles = initialSnapshot.content_manifest !== undefined && snapshot.content_manifest !== undefined
      ? changedSnapshotPaths(initialSnapshot, snapshot)
      : (await this.options.snapshots.changedFiles?.(workspace.path)) ?? result.files_changed;
    state = await this.updateRun(state.run_id, (draft) => {
      const draftTask = draft.graph.tasks.find((candidate) => candidate.id === taskId)!;
      draftTask.changed_files = changedFiles;
      draftTask.last_summary = result.summary;
      return draft;
    });
    const outsideScope = changedFiles.filter(
      (file) =>
        task.scope_paths.length > 0 &&
        !task.scope_paths.some(
          (scope) =>
            file === scope.replace(/\/$/, '') ||
            file.startsWith(`${scope.replace(/\/$/, '')}/`),
        ),
    );
    if (outsideScope.length > 0) {
      return await this.blockTaskForViolation(
        state,
        taskId,
        `worker changed files outside scope_paths: ${outsideScope.join(', ')}`,
      );
    }
    const missingOutputs = missingRequiredOutputs(task.required_outputs, changedFiles);
    if (missingOutputs.length > 0) {
      return await this.blockTaskForViolation(
        state,
        taskId,
        `worker did not produce required_outputs: ${missingOutputs.join(', ')}`,
      );
    }
    if (task.worker_role === 'reviewer' || task.worker_role === 'acceptance') {
      if (snapshot.id !== initialSnapshotId) {
        return await this.blockTaskForViolation(state, taskId, 'observation worker mutated source content');
      }
      const blocking = blockingFindings(result, state.config.review);
      if (blocking.length > 0) {
        await recordDecision(this.options.store, {
          run_id: state.run_id,
          phase: 'review',
          code: 'review_blocking',
          title: `独立评审发现阻塞问题：${taskId}`,
          detail: blocking.map((finding) => `[${finding.severity}] ${finding.title}`).join('\n'),
          outcome: 'fail',
          task_id: taskId,
          data: { findings: blocking },
        });
        state = await this.updateRun(state.run_id, (draft) => {
          changeTask(draft, taskId, 'VERIFYING');
          return draft;
        });
        state = await this.updateRun(state.run_id, draft => {
          draft.graph.tasks.find(t => t.id === taskId)!.failure_context = { summary: result.summary, findings: blocking };
          return draft;
        });
        state = await this.applyFix(
          state,
          taskId,
          'review_finding',
          blocking.map((finding) => finding.id).join(','),
          workspace,
        );
        return state;
      }
      const reviewEvidence: EvidenceRecord = {
        id: `E-${createHash('sha256').update(`${state.run_id}:${taskId}:review:${snapshot.id}`).digest('hex').slice(0, 16)}`,
        run_id: state.run_id,
        task_id: taskId,
        acceptance_ids: task.acceptance_ids,
        code_snapshot_id: snapshot.id,
        command: 'independent-review',
        cwd: workspace.path,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        exit_code: 0,
        stdout_path: '',
        stderr_path: '',
        result: 'passed',
      };
      this.evidence.push(reviewEvidence);
      await this.evidenceLedger?.append(reviewEvidence);
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'review',
        code: 'review_passed',
        title: `独立评审通过：${taskId}`,
        detail: result.summary,
        outcome: 'pass',
        task_id: taskId,
      });
      state = await this.updateRun(state.run_id, (draft) => {
        changeTask(draft, taskId, 'VERIFYING');
        changeTask(draft, taskId, 'DONE');
        draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
        return draft;
      });
      return state;
    }

    state = await this.updateRun(state.run_id, (draft) => {
      changeTask(draft, taskId, 'VERIFYING');
      return draft;
    });
    const failedEvidence = await this.verifyTask(state, taskId, workspace.path, snapshot.id);
    const cancelledDuringVerification = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
    if (cancelledDuringVerification !== undefined) return cancelledDuringVerification;
    if (failedEvidence?.result === 'error') {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'verify',
        code: 'verification_error',
        title: `验证执行错误：${failedEvidence.command}`,
        outcome: 'blocked',
        task_id: taskId,
        data: { evidence_id: failedEvidence.id },
      });
      return await this.blockVerificationError(state, failedEvidence, taskId);
    }
    if (failedEvidence !== undefined) {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'verify',
        code: 'verification_failed',
        title: `任务验证失败：${taskId}`,
        detail: `${failedEvidence.command} 退出码 ${failedEvidence.exit_code}`,
        outcome: 'fail',
        task_id: taskId,
        data: { command: failedEvidence.command, evidence_id: failedEvidence.id },
      });
      const output = `${await safeRead(failedEvidence.stderr_path)}\n${await safeRead(failedEvidence.stdout_path)}`;
      const fingerprint = failureFingerprint({
        taskId,
        command: failedEvidence.command,
        output,
      });
      state = await this.updateRun(state.run_id, draft => {
        draft.graph.tasks.find(t => t.id === taskId)!.failure_context = { summary: `${failedEvidence.command} failed\n${output}`, evidence: failedEvidence };
        return draft;
      });
      state = await this.applyFix(state, taskId, 'test_failure', fingerprint, workspace);
      return state;
    }
    const cancelledAfterVerification = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
    if (cancelledAfterVerification !== undefined) {
      return cancelledAfterVerification;
    }
    await recordDecision(this.options.store, {
      run_id: state.run_id,
      phase: 'verify',
      code: 'verification_passed',
      title: `任务验证通过：${taskId}`,
      detail: task.verification_commands.length > 0
        ? `已通过 ${task.verification_commands.length} 条验证命令。`
        : '该任务没有配置验证命令。',
      outcome: 'pass',
      task_id: taskId,
      data: { commands: task.verification_commands },
    });

    if (taskRequiresReview(task, state.config)) {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'review',
        code: 'review_requested',
        title: `安排独立评审：${taskId}`,
        detail: `评审策略 ${task.review_policy}，任务风险 ${task.risk}。`,
        outcome: 'info',
        task_id: taskId,
      });
      state = await this.updateRun(state.run_id, (draft) => {
        changeTask(draft, taskId, 'REVIEWING');
        return draft;
      });
      const reviewerSkills = await this.resolveSkills(task, 'reviewer', state);
      const reviewResult = await this.runWorkerWithCancellation(
        state.run_id,
        await this.agentRequest(
          state,
          task,
          reviewerSkills,
          workspace.path,
          'reviewer',
          `独立评审任务 ${taskId} 的Diff、证据和验收条件`,
        ),
      );
      state = await this.accountUsage(state.run_id, reviewResult.token_usage);
      const cancelledDuringReview = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
      if (cancelledDuringReview !== undefined) return cancelledDuringReview;
      if (reviewResult.task_id !== taskId || (state.total_tokens_used ?? 0) > state.config.runtime.max_total_tokens) {
        return await this.blockTaskForViolation(state, taskId, 'review protocol or token budget violation');
      }
      const reviewedSnapshot = await this.options.snapshots.create(workspace.path, state.baseline_commit ?? 'HEAD');
      if (reviewedSnapshot.id !== snapshot.id) {
        return await this.blockTaskForViolation(state, taskId, 'reviewer mutated source content');
      }
      if (reviewResult.status === 'blocked') {
        const reviewBlockers = normalizeBlockers(taskId, reviewResult.summary, reviewResult.blockers);
        state = await this.updateRun(state.run_id, (draft) => {
          changeTask(draft, taskId, 'INTERRUPTED');
          draft.pending_decision_ids = [...new Set([...draft.pending_decision_ids, ...reviewBlockers.map((blocker) => blocker.decision_id)])];
          draft.decision_blockers = [...(draft.decision_blockers ?? []), ...reviewBlockers];
          draft.pending_decision_tasks ??= {};
          for (const blocker of reviewBlockers) {
            draft.pending_decision_tasks[blocker.decision_id] = blocker.affected_task_ids;
          }
          draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
          changeRun(draft, 'WAITING_HUMAN');
          return draft;
        });
        await recordDecision(this.options.store, {
          run_id: state.run_id,
          phase: 'human',
          code: 'review_blocked',
          title: `评审需要人工决策：${taskId}`,
          detail: reviewResult.summary,
          outcome: 'waiting',
          task_id: taskId,
          data: { blockers: reviewBlockers },
        });
        return state;
      }
      if (reviewResult.status === 'failed') {
        await recordDecision(this.options.store, {
          run_id: state.run_id,
          phase: 'review',
          code: 'review_failed',
          title: `评审 Worker 执行失败：${taskId}`,
          detail: reviewResult.summary,
          outcome: 'fail',
          task_id: taskId,
        });
        state = await this.retryInterruptedTask(state, taskId, reviewResult.summary);
        return state;
      }
      const blocking = blockingFindings(reviewResult, state.config.review);
      if (blocking.length > 0) {
        await recordDecision(this.options.store, {
          run_id: state.run_id,
          phase: 'review',
          code: 'review_blocking',
          title: `评审发现阻塞问题：${taskId}`,
          detail: blocking.map((finding) => `[${finding.severity}] ${finding.title}`).join('\n'),
          outcome: 'fail',
          task_id: taskId,
          data: { findings: blocking },
        });
        state = await this.updateRun(state.run_id, draft => {
          draft.graph.tasks.find(t => t.id === taskId)!.failure_context = { summary: reviewResult.summary, findings: blocking };
          return draft;
        });
        state = await this.applyFix(
          state,
          taskId,
          'review_finding',
          blocking.map((finding) => finding.id).join(','),
          workspace,
        );
        return state;
      }
      const reviewEvidence: EvidenceRecord = {
        id: `E-${createHash('sha256').update(`${state.run_id}:${taskId}:independent-review:${snapshot.id}`).digest('hex').slice(0, 16)}`,
        run_id: state.run_id,
        task_id: taskId,
        acceptance_ids: task.acceptance_ids,
        code_snapshot_id: snapshot.id,
        command: 'independent-review',
        cwd: workspace.path,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        exit_code: 0,
        stdout_path: '',
        stderr_path: '',
        result: 'passed',
      };
      this.evidence.push(reviewEvidence);
      await this.evidenceLedger?.append(reviewEvidence);
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'review',
        code: 'review_passed',
        title: `独立评审通过：${taskId}`,
        detail: reviewResult.summary,
        outcome: 'pass',
        task_id: taskId,
      });
    }

    state = await this.updateRun(state.run_id, (draft) => {
      changeTask(draft, taskId, 'INTEGRATING');
      return draft;
    });
    const cancelledBeforeIntegration = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
    if (cancelledBeforeIntegration !== undefined) {
      return cancelledBeforeIntegration;
    }
    const integrationOutcome = await this.withKeyLock(
      this.integrationLocks,
      state.run_id,
      async () => {
        const latest = (await this.options.store.readRun(state.run_id)) ?? state;
        if (latest.status === 'CANCELLED') {
          return {
            integration: { ok: false, error: 'run cancelled' },
            state: latest,
            failure: undefined,
            cancelled: true,
          };
        }
        const integration = await this.options.integrator.integrate(
          latest,
          task,
          workspace.path,
          snapshot,
        );
        if (
          !integration.ok ||
          integration.workdir === undefined ||
          integration.snapshot_id === undefined
        ) {
          return { integration, state, failure: undefined, cancelled: false };
        }
        const integrationSnapshotId = integration.snapshot_id;
        const integrationWorkdir = integration.workdir;
        const failure = await this.verifyTask(
          latest,
          taskId,
          integrationWorkdir,
          integrationSnapshotId,
        );
        if (failure !== undefined) return { integration, state: latest, failure, cancelled: false };
        const nextState = await this.updateRun(state.run_id, (draft) => {
          if (draft.status === 'CANCELLED') return draft;
          draft.integration_snapshot_id = integrationSnapshotId;
          draft.integration_worktree = integrationWorkdir;
          if (integration.artifact !== undefined) draft.delivery_artifact = integration.artifact;
          delete draft.final_verification_snapshot_id;
          const draftTask = draft.graph.tasks.find((candidate) => candidate.id === taskId)!;
          draftTask.code_snapshot_id = integrationSnapshotId;
          return draft;
        });
        return { integration, state: nextState, failure, cancelled: false };
      },
    );
    state = integrationOutcome.state;
    const cancelledDuringIntegration = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
    if (cancelledDuringIntegration !== undefined) return cancelledDuringIntegration;
    if (integrationOutcome.failure?.result === 'error') return await this.blockVerificationError(state, integrationOutcome.failure, taskId);
    if (integrationOutcome.cancelled) {
      return (await this.cancelTaskIfRunCancelled(state.run_id, taskId)) ?? state;
    }
    if (!integrationOutcome.integration.ok || integrationOutcome.integration.workdir === undefined || integrationOutcome.integration.snapshot_id === undefined) {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'integrate',
        code: 'integration_failed',
        title: `集成失败：${taskId}`,
        detail: integrationOutcome.integration.error ?? 'integration failed',
        outcome: 'fail',
        task_id: taskId,
      });
      state = await this.applyFix(
        state,
        taskId,
        'test_failure',
        integrationOutcome.integration.error ?? 'integration failed',
        workspace,
      );
      return state;
    }

    if (integrationOutcome.failure !== undefined) {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'integrate',
        code: 'integration_verification_failed',
        title: `集成后验证失败：${taskId}`,
        detail: `${integrationOutcome.failure.command} 退出码 ${integrationOutcome.failure.exit_code}`,
        outcome: 'fail',
        task_id: taskId,
        data: { command: integrationOutcome.failure.command, evidence_id: integrationOutcome.failure.id },
      });
      const output = await safeRead(integrationOutcome.failure.stderr_path);
      const fingerprint = failureFingerprint({
        taskId,
        command: integrationOutcome.failure.command,
        output,
      });
      const failedWorkdir = integrationOutcome.integration.workdir ?? workspace.path;
      state = await this.updateRun(state.run_id, draft => {
        draft.graph.tasks.find(t => t.id === taskId)!.failure_context = { summary: `integration verification failed: ${integrationOutcome.failure!.command}\n${output}`, evidence: integrationOutcome.failure! };
        return draft;
      });
      state = await this.applyFix(state, taskId, 'test_failure', fingerprint, { path: failedWorkdir, cleanup: async () => {} });
      return state;
    }
    const cancelledAfterIntegration = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
    if (cancelledAfterIntegration !== undefined) {
      return cancelledAfterIntegration;
    }

    await recordDecision(this.options.store, {
      run_id: state.run_id,
      phase: 'integrate',
      code: 'integration_passed',
      title: `集成并通过验证：${taskId}`,
      detail: integrationOutcome.integration.snapshot_id ?? '',
      outcome: 'pass',
      task_id: taskId,
      data: {
        snapshot_id: integrationOutcome.integration.snapshot_id ?? null,
        workdir: integrationOutcome.integration.workdir ?? null,
        artifact: integrationOutcome.integration.artifact ?? null,
      },
    });
    state = await this.updateRun(state.run_id, (draft) => {
      changeTask(draft, taskId, 'DONE');
      const completedTask = draft.graph.tasks.find((candidate) => candidate.id === taskId)!;
      if (completedTask.repairs_task_id !== undefined) {
        const source = draft.graph.tasks.find(
          (candidate) => candidate.id === completedTask.repairs_task_id,
        );
        if (source?.status === 'FIX_REQUIRED') {
          changeTask(draft, source.id, 'PENDING');
          // The repair task integrated the missing output into the seed, so the
          // source task's next attempt diff starts after it. Re-checking the
          // original required_outputs against that now-empty diff would block
          // every repaired task; the repair chain carries the accepted output,
          // matching the semantics of the repair task's own empty list.
          source.required_outputs = [];
          delete source.seed_worktree;
          delete source.failure_context;
        }
      }
      draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
      return draft;
    });
    await this.options.store.appendEvent(state.run_id, { type: 'task_done', task_id: taskId });
    await recordDecision(this.options.store, {
      run_id: state.run_id,
      phase: 'execute',
      code: 'task_done',
      title: `任务完成：${taskId}`,
      detail: state.graph.tasks.find((candidate) => candidate.id === taskId)?.last_summary ?? '',
      outcome: 'pass',
      task_id: taskId,
    });
    if (state.config.git.delete_worktree_on_success) {
      await workspace.cleanup();
    }
    return state;
  }

  private async agentRequest(
    state: RunState,
    task: TaskNode,
    skills: ResolvedSkill[],
    workdir: string,
    role: WorkerRole = roleForTask(task),
    objective = task.title,
  ): Promise<AgentRequest> {
    return {
      run_id: state.run_id,
      task_id: task.id,
      role,
      capability_profile: task.capability_profile,
      required_skills: skills,
      objective,
      workdir,
      requirement_ids: task.requirement_ids,
      acceptance_ids: task.acceptance_ids,
      scope_paths: task.scope_paths,
      constraints: [
        '不得执行git commit、git push、git merge或部署',
        '不得执行git add或修改索引',
        '不得递归创建交付运行或交付Worker',
        '完成当前任务后停止',
      ],
      verification_commands: task.verification_commands,
      context_files: ['AGENTS.md'],
      context: {
        specification: await safeRead(this.options.store.getRunDirectory(state.run_id) + '/spec.md'),
        requirements: state.graph.requirements ?? [],
        acceptance: state.graph.acceptance ?? [],
        decisions: state.decisions ?? [],
        ...(state.baseline_verification_id === undefined
          ? {}
          : {
            baseline: {
              verification_id: state.baseline_verification_id,
              failed_commands: state.baseline_failures ?? [],
            },
          }),
        ...(task.failure_context === undefined ? {} : { failure: task.failure_context }),
      },
      timeout_seconds: state.config.runtime.default_worker_timeout_seconds,
    };
  }

  private async verifyTask(
    state: RunState,
    taskId: string,
    cwd: string,
    snapshotId: string,
  ): Promise<EvidenceRecord | undefined> {
    const task = state.graph.tasks.find((candidate) => candidate.id === taskId)!;
    for (const command of task.verification_commands) {
      const record = await this.runVerification({
        run_id: state.run_id,
        task_id: taskId,
        acceptance_ids: task.acceptance_ids,
        code_snapshot_id: snapshotId,
        command,
        expected_exit_code: (() => {
          const condition = (state.graph.acceptance ?? []).find(condition => task.acceptance_ids.includes(condition.id) && 'command' in condition.verification && condition.verification.command === command);
          return condition !== undefined && 'expected_exit_code' in condition.verification ? condition.verification.expected_exit_code : 0;
        })(),
        cwd,
        timeout_seconds: state.config.runtime.default_worker_timeout_seconds,
      });
      const after = await this.options.snapshots.create(cwd, state.baseline_commit ?? 'HEAD');
      if (after.id !== snapshotId) {
        record.result = 'error';
        await this.updateRun(state.run_id, draft => ({ ...draft, last_error: `verification mutated content: ${command}` }));
      }
      this.evidence.push(record);
      await this.evidenceLedger?.append(record);
      if (record.result !== 'passed') {
        return record;
      }
    }
    return undefined;
  }

  private async blockVerificationError(state: RunState, evidence: EvidenceRecord, taskId?: string): Promise<RunState> {
    const output = `${await safeRead(evidence.stderr_path)}\n${await safeRead(evidence.stdout_path)}`.trim();
    return await this.updateRun(state.run_id, draft => {
      if (draft.status === 'CANCELLED') return draft;
      if (taskId !== undefined) {
        const task = draft.graph.tasks.find(candidate => candidate.id === taskId)!;
        task.failure_context = { summary: `verification execution error: ${evidence.command}`, evidence };
        changeTask(draft, taskId, 'BLOCKED');
        draft.current_task_ids = draft.current_task_ids.filter(id => id !== taskId);
      }
      draft.last_error = `verification execution error: ${evidence.command}${output ? `\n${output}` : ''}`;
      changeRun(draft, 'BLOCKED');
      return draft;
    });
  }

  private async applyFix(
    state: RunState,
    taskId: string,
    origin: TaskNode['origin'],
    failureKey: string,
    workspace: TaskWorkspace,
  ): Promise<RunState> {
    const task = state.graph.tasks.find((candidate) => candidate.id === taskId)!;
    const fingerprint = failureFingerprint({ taskId, command: origin, output: failureKey });
    let blocked = false;
    let createdFixId: string | undefined;
    const next = await this.updateRun(state.run_id, (draft) => {
      if (draft.status === 'CANCELLED') return draft;
      const draftTask = draft.graph.tasks.find((candidate) => candidate.id === taskId)!;
      const dynamicTaskCount = draft.graph.tasks.filter(
        (candidate) => candidate.origin !== 'initial_plan',
      ).length;
      const effectiveMaxAttempts = Math.min(draftTask.max_attempts, draft.config.runtime.max_task_attempts);
      if (
        draftTask.attempt >= effectiveMaxAttempts ||
        dynamicTaskCount >= draft.config.runtime.max_dynamic_tasks ||
        (draftTask.dynamic_depth ?? 0) >= draft.config.runtime.max_dynamic_depth
      ) {
        changeTask(draft, taskId, 'BLOCKED');
        draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
        draft.last_error = `dynamic task or retry budget exhausted for ${taskId}`;
        blocked = true;
        if (draft.status !== 'BLOCKED') {
          changeRun(draft, 'BLOCKED');
        }
        return draft;
      }
      changeTask(draft, taskId, 'FIX_REQUIRED');
      draftTask.last_failure_fingerprint = fingerprint;
      draftTask.attempt += 1;
      const fix = createFixTask(draft, origin, draftTask, fingerprint);
      createdFixId = fix.id;
      fix.seed_worktree = workspace.path;
      fix.failure_context = { summary: failureKey, ...(draftTask.failure_context ?? {}) };
      draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
      if (draft.status === 'VERIFYING') {
        changeRun(draft, 'RUNNING');
      }
      return draft;
    });
    await this.options.store.appendEvent(state.run_id, {
      type: blocked ? 'run_blocked_budget' : 'fix_required',
      task_id: taskId,
      origin,
      fingerprint,
    });
    if (blocked) {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'dispatch',
        code: 'retry_budget_exhausted',
        title: `重试或动态任务预算耗尽：${taskId}`,
        detail: `来源 ${origin}，失败指纹 ${fingerprint}。`,
        outcome: 'blocked',
        task_id: taskId,
        data: { origin, fingerprint },
      });
    } else {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'dispatch',
        code: 'fix_task_created',
        title: `创建修复任务：${createdFixId ?? '(unknown)'}`,
        detail: `任务 ${taskId} 因 ${origin} 进入修复流程，第 ${task.attempt} 次尝试。`,
        outcome: 'info',
        task_id: taskId,
        data: {
          origin,
          fingerprint,
          fix_task_id: createdFixId ?? null,
          repair_of: taskId,
        },
      });
    }
    return next;
  }

  private async finishOrContinueAcceptance(state: RunState): Promise<RunState> {
    state = await this.requireRun(state.run_id);
    if (['COMPLETED', 'CANCELLED', 'BLOCKED', 'WAITING_HUMAN', 'PAUSED'].includes(state.status)) return state;
    const tasksComplete = state.graph.tasks.every(
      (task) => task.status === 'DONE' || task.status === 'CANCELLED',
    );
    if (!tasksComplete) {
      return state;
    }
    if (state.integration_worktree !== undefined && state.integration_snapshot_id !== undefined) {
      const actual = await this.options.snapshots.create(state.integration_worktree, state.baseline_commit ?? 'HEAD');
      if (actual.id !== state.integration_snapshot_id) {
        return await this.updateRun(state.run_id, draft => {
          draft.last_error = 'accepted integration content no longer matches its snapshot';
          changeRun(draft, 'BLOCKED');
          return draft;
        });
      }
    }
    // A final review only exists to review accepted integration content. Without
    // an integration snapshot (zero-task or review/acceptance-only deliveries)
    // the review never binds to a snapshot, so every tick would reset its DONE
    // task back to READY and the run could never complete.
    const acceptedIntegrationSnapshotId = state.integration_snapshot_id;
    if (state.config.review.final_review && acceptedIntegrationSnapshotId !== undefined) {
      const finalReview = state.graph.tasks.find((task) => task.id === 'FINAL-REVIEW');
      if (finalReview === undefined) {
        await recordDecision(this.options.store, {
          run_id: state.run_id,
          phase: 'review',
          code: 'final_review_requested',
          title: '安排最终独立评审',
          detail: '所有任务已结束，开始对整个集成快照做最终评审。',
          outcome: 'info',
        });
        return await this.updateRun(state.run_id, (draft) => {
          if (draft.status === 'VERIFYING') {
            changeRun(draft, 'RUNNING');
          }
          draft.graph.tasks.push({
            id: 'FINAL-REVIEW',
            type: 'verification',
            title: 'Perform final independent review',
            status: 'READY',
            priority: 'high',
            risk: 'high',
            origin: 'initial_plan',
            depends_on: draft.graph.tasks
              .filter((task) => task.status === 'DONE')
              .map((task) => task.id),
            requirement_ids: (draft.graph.requirements ?? []).map((requirement) => requirement.id),
            acceptance_ids: (draft.graph.acceptance ?? [])
              .filter((condition) => condition.verification.type === 'review')
              .map((condition) => condition.id),
            scope_paths: [],
            required_outputs: [],
            worker_role: 'reviewer',
            capability_profile: draft.config.profile,
            attempt: 0,
            // Retry budget comes from the run configuration: resetting a stale
            // review must be able to claim a new attempt, and the cost must be
            // counted like every other task retry.
            max_attempts: draft.config.runtime.max_task_attempts,
            verification_commands: [],
            review_policy: 'none',
          });
          return draft;
        });
      }
      if (
        finalReview.status === 'DONE' &&
        finalReview.code_snapshot_id !== acceptedIntegrationSnapshotId
      ) {
        let budgetExhausted = false;
        const next = await this.updateRun(state.run_id, draft => {
          if (draft.status === 'CANCELLED') return draft;
          const draftReview = draft.graph.tasks.find((task) => task.id === 'FINAL-REVIEW');
          if (draftReview === undefined) return draft;
          // The final review is controller-owned; its retry budget is the run
          // configuration so raising `max_task_attempts` on resume can recover
          // a review whose content kept changing.
          const effectiveMaxAttempts = draft.config.runtime.max_task_attempts;
          if (draftReview.attempt + 1 >= effectiveMaxAttempts) {
            budgetExhausted = true;
            draft.last_error = `final review retry budget exhausted for ${draftReview.id}`;
            if (draft.status !== 'BLOCKED') changeRun(draft, 'BLOCKED');
            return draft;
          }
          // Reusing the old attempt path would reuse the stale worktree and its
          // old snapshot, so the snapshot comparison would fail on every tick.
          // A new attempt gets a new worktree seeded from the current accepted
          // integration content.
          draftReview.attempt += 1;
          delete draftReview.seed_worktree;
          delete draftReview.failure_context;
          changeTask(draft, draftReview.id, 'READY');
          if (draft.status === 'VERIFYING') changeRun(draft, 'RUNNING');
          return draft;
        });
        await recordDecision(this.options.store, {
          run_id: state.run_id,
          phase: 'review',
          code: budgetExhausted ? 'final_review_budget_exhausted' : 'final_review_reset',
          title: budgetExhausted ? '最终评审重试预算耗尽' : '集成内容已变化，重新安排最终评审',
          detail: budgetExhausted
            ? '最终评审重试次数已达上限；集成内容在评审后再次变化，请提高 max_task_attempts 或新建运行。'
            : `最终评审快照 ${finalReview.code_snapshot_id ?? '(none)'} 与已接受集成快照 ${acceptedIntegrationSnapshotId} 不一致，使用新 attempt 重新评审。`,
          outcome: budgetExhausted ? 'blocked' : 'info',
          data: {
            reviewed_snapshot_id: finalReview.code_snapshot_id ?? null,
            accepted_snapshot_id: acceptedIntegrationSnapshotId,
            attempt: finalReview.attempt + (budgetExhausted ? 0 : 1),
          },
        });
        return next;
      }
      if (finalReview.status !== 'DONE') {
        return state;
      }
    }
    if (state.status === 'RUNNING') {
      state = await this.updateRun(state.run_id, (draft) => {
        changeRun(draft, 'VERIFYING');
        return draft;
      });
    }
    if (
      state.integration_snapshot_id !== undefined &&
      state.integration_worktree !== undefined &&
      state.final_verification_snapshot_id !== state.integration_snapshot_id
    ) {
      const integrationSnapshotId = state.integration_snapshot_id;
      const commands = compileVerificationPlan(state);
      for (const check of commands) {
        const evidence = await this.runVerification({
          run_id: state.run_id,
          task_id: 'FINAL-VERIFICATION',
          acceptance_ids: check.acceptance_ids,
          code_snapshot_id: integrationSnapshotId,
          command: check.command,
          expected_exit_code: check.expected_exit_code,
          cwd: state.integration_worktree,
          timeout_seconds: state.config.runtime.default_worker_timeout_seconds,
        });
        const latest = await this.requireRun(state.run_id);
        if (latest.status === 'CANCELLED') return latest;
        const after = await this.options.snapshots.create(state.integration_worktree, state.baseline_commit ?? 'HEAD');
        if (after.id !== integrationSnapshotId) {
          evidence.result = 'error';
          await this.evidenceLedger?.append(evidence);
          this.evidence.push(evidence);
          return await this.updateRun(state.run_id, draft => {
            draft.last_error = `final verification mutated content: ${check.command}`;
            changeRun(draft, 'BLOCKED');
            return draft;
          });
        }
        await this.evidenceLedger?.append(evidence);
        this.evidence.push(evidence);
        if (evidence.result === 'error') {
          await recordDecision(this.options.store, {
            run_id: state.run_id,
            phase: 'accept',
            code: 'final_verification_error',
            title: `最终验证执行错误：${check.command}`,
            outcome: 'blocked',
            data: { command: check.command, evidence_id: evidence.id },
          });
          return await this.blockVerificationError(state, evidence);
        }
        if (evidence.result !== 'passed') {
          await recordDecision(this.options.store, {
            run_id: state.run_id,
            phase: 'accept',
            code: 'final_verification_failed',
            title: `最终验证失败：${check.command}`,
            detail: `退出码 ${evidence.exit_code}；将尝试创建验收修复任务。`,
            outcome: 'fail',
            data: { command: check.command, evidence_id: evidence.id },
          });
          return await this.updateRun(state.run_id, (draft) => {
            if (draft.status === 'CANCELLED') return draft;
            const sources = draft.graph.tasks.filter(task => task.origin === 'initial_plan' && task.worker_role !== 'reviewer' && task.worker_role !== 'acceptance' && (check.acceptance_ids.some(id => task.acceptance_ids.includes(id)) || task.verification_commands.includes(check.command)));
            const source = sources.length === 1 ? sources[0] : undefined;
            const dynamicTaskCount = draft.graph.tasks.filter(task => task.origin !== 'initial_plan').length;
            const effectiveMaxAttempts = source === undefined ? 0 : Math.min(source.max_attempts, draft.config.runtime.max_task_attempts);
            if (source === undefined || source.attempt + 1 >= effectiveMaxAttempts || dynamicTaskCount >= draft.config.runtime.max_dynamic_tasks || (source.dynamic_depth ?? 0) >= draft.config.runtime.max_dynamic_depth) {
              draft.last_error = 'final verification failed; repair target unavailable or budget exhausted';
              changeRun(draft, 'BLOCKED');
              return draft;
            }
            source.attempt += 1;
            const repairSource = { ...source, required_outputs: [], verification_commands: [check.command], max_attempts: effectiveMaxAttempts };
            const fix = createFixTask(draft, 'acceptance_gap', repairSource, `final verification failed: ${check.command}`);
            fix.repairs_task_id = source.id;
            if (draft.integration_worktree !== undefined) fix.seed_worktree = draft.integration_worktree;
            fix.failure_context = { summary: `final verification failed: ${check.command}`, evidence };
            delete draft.final_verification_snapshot_id;
            changeRun(draft, 'RUNNING');
            return draft;
          });
        }
      }
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'accept',
        code: 'final_verification_passed',
        title: '最终验证通过',
        detail: `集成快照 ${integrationSnapshotId} 的全部检查已通过。`,
        outcome: 'pass',
        data: { snapshot_id: integrationSnapshotId, commands: commands.map((check) => check.command) },
      });
      state = await this.updateRun(state.run_id, (draft) => {
        draft.final_verification_snapshot_id = integrationSnapshotId;
        return draft;
      });
    }
    const latestSnapshot = acceptedContentSnapshotId(state);
    const persistedEvidence = await this.evidenceLedger?.readAll(state.run_id);
    const acceptanceEvidence = persistedEvidence ?? this.evidence;
    const artifactConditions = (state.graph.acceptance ?? []).filter(
      (condition) => condition.mandatory && condition.verification.type === 'artifact',
    );
    if (artifactConditions.length > 0 && latestSnapshot !== undefined) {
      const artifactConditionIds = artifactConditions.map((condition) => condition.id);
      const alreadyChecked = acceptanceEvidence.some(
        (record) =>
          record.command === 'artifact-check' &&
          record.result === 'passed' &&
          record.code_snapshot_id === latestSnapshot &&
          artifactConditionIds.every((id) => record.acceptance_ids.includes(id)),
      );
      if (!alreadyChecked) {
        let passed = false;
        if (state.delivery_artifact !== undefined) {
          try {
            const content = await readFile(state.delivery_artifact.path, 'utf8');
            passed = createHash('sha256').update(content).digest('hex') === state.delivery_artifact.sha256;
          } catch {
            passed = false;
          }
        }
        const record: EvidenceRecord = {
          id: `E-${createHash('sha256').update(`${state.run_id}:artifact-check:${latestSnapshot}`).digest('hex').slice(0, 16)}`,
          run_id: state.run_id,
          task_id: 'FINAL-VERIFICATION',
          acceptance_ids: artifactConditionIds,
          code_snapshot_id: latestSnapshot,
          command: 'artifact-check',
          cwd: state.integration_worktree ?? state.repo_root,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          exit_code: passed ? 0 : 1,
          stdout_path: '',
          stderr_path: '',
          result: passed ? 'passed' : 'failed',
        };
        acceptanceEvidence.push(record);
        this.evidence.push(record);
        await this.evidenceLedger?.append(record);
        await recordDecision(this.options.store, {
          run_id: state.run_id,
          phase: 'accept',
          code: passed ? 'artifact_check_passed' : 'artifact_check_failed',
          title: passed ? '交付产物校验通过' : '交付产物校验失败',
          detail: passed ? state.delivery_artifact?.path ?? '' : 'delivery artifact is missing or its digest does not match',
          outcome: passed ? 'pass' : 'fail',
          data: { artifact: state.delivery_artifact ?? null, snapshot_id: latestSnapshot },
        });
      }
    }
    const result = evaluateAcceptance(state.graph, acceptanceEvidence, latestSnapshot);
    if (result.status === 'WAITING_HUMAN') {
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'accept',
        code: 'acceptance_waiting_human',
        title: '验收需要人工确认',
        detail: result.reasons.join('\n') || '存在只能由人工确认的验收条件。',
        outcome: 'waiting',
        data: { reasons: result.reasons, decision_ids: state.pending_decision_ids },
      });
      return await this.updateRun(state.run_id, (draft) => {
        changeRun(draft, 'WAITING_HUMAN');
        const manualConditions = (draft.graph.acceptance ?? []).filter(
          (condition) => condition.mandatory && condition.verification.type === 'manual',
        );
        const manualIds = new Set(manualConditions.map((condition) => condition.id));
        const approved = new Set(
          manualConditions
            .filter((condition) =>
              acceptanceEvidence.some(
                (record) =>
                  record.command === 'manual-approval' &&
                  record.result === 'passed' &&
                  record.acceptance_ids.includes(condition.id) &&
                  (latestSnapshot === undefined || record.code_snapshot_id === latestSnapshot),
              ),
            )
            .map((condition) => condition.id),
        );
        const retained = draft.pending_decision_ids.filter((id) => !manualIds.has(id));
        const pendingManual = manualConditions
          .filter((condition) => !approved.has(condition.id))
          .map((condition) => condition.id);
        const merged = [...new Set([...retained, ...pendingManual])];
        draft.pending_decision_ids = merged.length > 0
          ? merged
          : result.reasons.map((_reason, index) => `ACCEPTANCE-${index + 1}`);
        return draft;
      });
    }
    if (result.status === 'PASSED') {
      if (state.delivery_artifact !== undefined) {
        const content = await readFile(state.delivery_artifact.path, 'utf8');
        if (createHash('sha256').update(content).digest('hex') !== state.delivery_artifact.sha256) throw new Error('accepted patch artifact digest mismatch');
        await this.options.store.writeArtifact(state.run_id, state.config.git.final_artifact, content);
      }
      const currentEvidence = acceptanceEvidence.filter(record => record.code_snapshot_id === latestSnapshot);
      const reportState = structuredClone(state);
      reportState.status = 'COMPLETED';
      for (const requirement of reportState.graph.requirements ?? []) requirement.status = 'SATISFIED';
      await writeDeliveryReport(state.repo_root, reportState, currentEvidence);
      const certificate = `${JSON.stringify({
        run_id: state.run_id,
        snapshot_id: latestSnapshot,
        graph_digest: createHash('sha256').update(JSON.stringify(reportState.graph)).digest('hex'),
        config_digest: createHash('sha256').update(JSON.stringify(state.config)).digest('hex'),
        evidence: currentEvidence,
        artifact: state.delivery_artifact,
        decisions: state.decisions ?? [],
        total_tokens_used: state.total_tokens_used ?? 0,
        usage_incomplete: state.usage_incomplete ?? false,
        generated_at: new Date().toISOString(),
      }, null, 2)}\n`;
      const certificatePath = await this.options.store.writeArtifact(state.run_id, 'completion.json', certificate);
      await recordDecision(this.options.store, {
        run_id: state.run_id,
        phase: 'accept',
        code: 'acceptance_passed',
        title: '验收通过，交付完成',
        detail: '所有强制验收条件均有可追溯证据支持。',
        outcome: 'pass',
        data: {
          snapshot_id: latestSnapshot ?? null,
          requirements: (state.graph.requirements ?? []).length,
          acceptance: (state.graph.acceptance ?? []).length,
          report_path: join(state.repo_root, '.delivery', 'runs', state.run_id, 'reports', 'final.md'),
          completion_path: certificatePath,
        },
      });
      return await this.updateRun(state.run_id, (draft) => {
        for (const requirement of draft.graph.requirements ?? []) {
          requirement.status = 'SATISFIED';
        }
        draft.completion_ref = { path: certificatePath, sha256: createHash('sha256').update(certificate).digest('hex') };
        changeRun(draft, 'COMPLETED');
        return draft;
      });
    }

    await recordDecision(this.options.store, {
      run_id: state.run_id,
      phase: 'accept',
      code: 'acceptance_blocked',
      title: '验收证据不可用，运行已阻塞',
      detail: result.reasons.join('; '),
      outcome: 'blocked',
      data: { reasons: result.reasons },
    });
    return await this.updateRun(state.run_id, (draft) => {
      draft.last_error = `acceptance evidence unavailable: ${result.reasons.join('; ')}`;
      changeRun(draft, 'BLOCKED');
      return draft;
    });
  }

  async pause(runId: string): Promise<RunState> {
    const state = await this.updateRun(runId, (draft) => {
      draft.pause_requested = true;
      return draft;
    });
    await recordDecision(this.options.store, {
      run_id: runId,
      phase: 'lifecycle',
      code: 'pause_requested',
      title: '收到人工暂停请求',
      outcome: 'info',
    });
    return state;
  }

  async resume(
    runId: string,
    options: {
      max_total_tokens?: number;
      max_duration_hours?: number;
      max_task_attempts?: number;
    } = {},
  ): Promise<RunState> {
    let current = await this.requireRun(runId);
    if (['COMPLETED', 'CANCELLED'].includes(current.status)) {
      return current;
    }
    if (
      options.max_total_tokens !== undefined ||
      options.max_duration_hours !== undefined ||
      options.max_task_attempts !== undefined
    ) {
      current = await this.updateRun(runId, (draft) => {
        if (options.max_total_tokens !== undefined) {
          if (!Number.isInteger(options.max_total_tokens) || options.max_total_tokens <= draft.config.runtime.max_total_tokens) {
            throw new Error('max_total_tokens can only be increased on resume');
          }
          draft.config.runtime.max_total_tokens = options.max_total_tokens;
        }
        if (options.max_duration_hours !== undefined) {
          if (!(options.max_duration_hours > draft.config.runtime.max_duration_hours)) {
            throw new Error('max_duration_hours can only be increased on resume');
          }
          draft.config.runtime.max_duration_hours = options.max_duration_hours;
        }
        if (options.max_task_attempts !== undefined) {
          if (!Number.isInteger(options.max_task_attempts) || options.max_task_attempts <= draft.config.runtime.max_task_attempts) {
            throw new Error('max_task_attempts can only be increased on resume');
          }
          draft.config.runtime.max_task_attempts = options.max_task_attempts;
        }
        return draft;
      });
    }
    if (current.status === 'WAITING_HUMAN' && current.pending_decision_ids.length > 0) {
      throw new Error('run is waiting for human decisions; answer the pending decisions before resuming');
    }
    if (durationExceeded(current)) {
      throw new Error(
        `maximum run duration exceeded; resume with a larger max_duration_hours or start a new run`,
      );
    }
    if ((current.total_tokens_used ?? 0) > current.config.runtime.max_total_tokens) {
      throw new Error(
        'token budget exceeded; resume with a larger max_total_tokens or start a new run',
      );
    }
    let requeued: string[] = [];
    let remainingBlocked = false;
    const state = await this.updateRun(runId, (draft) => {
      draft.pause_requested = false;
      const candidates = draft.status === 'PAUSED' || draft.status === 'BLOCKED' || draft.status === 'QUEUED' || draft.status === 'WAITING_HUMAN';
      if (!candidates) {
        return draft;
      }
      for (const task of draft.graph.tasks) {
        const unresolved = draft.pending_decision_ids.some(
          (id) => (draft.pending_decision_tasks?.[id] ?? []).includes(task.id),
        );
        if (unresolved) continue;
        const effectiveMaxAttempts = Math.min(task.max_attempts, draft.config.runtime.max_task_attempts);
        if (task.status === 'BLOCKED' && task.attempt < effectiveMaxAttempts) {
          if (task.workspace_path !== undefined) task.seed_worktree = task.workspace_path;
          task.attempt += 1;
          changeTask(draft, task.id, 'READY');
          requeued.push(task.id);
        } else if (task.status === 'BLOCKED') {
          remainingBlocked = true;
        } else if (task.status === 'INTERRUPTED') {
          changeTask(draft, task.id, 'READY');
          requeued.push(task.id);
        } else if (IN_FLIGHT_TASK_STATUSES.has(task.status)) {
          // A tick failure blocks the run without touching the task that was
          // executing. `resume` must adopt these states, or the run has no
          // normal way out ("no task can be resumed"). Adopting an in-flight
          // task costs an attempt, matching the worker-failure budget.
          changeTask(draft, task.id, 'INTERRUPTED');
          if (task.workspace_path !== undefined) task.seed_worktree = task.workspace_path;
          task.attempt += 1;
          if (task.attempt >= effectiveMaxAttempts) {
            changeTask(draft, task.id, 'BLOCKED');
            remainingBlocked = true;
          } else {
            changeTask(draft, task.id, 'READY');
            requeued.push(task.id);
          }
        }
      }
      // Tasks adopted by this resume are no longer executing; keep only tasks
      // that are still genuinely in flight (e.g. one awaiting a decision).
      draft.current_task_ids = draft.graph.tasks
        .filter((task) => IN_FLIGHT_TASK_STATUSES.has(task.status))
        .map((task) => task.id);
      const allDone = draft.graph.tasks.every(
        (task) => task.status === 'DONE' || task.status === 'CANCELLED',
      );
      const hasReady = draft.graph.tasks.some((task) => task.status === 'READY');
      if (hasReady || allDone) {
        changeRun(draft, 'RUNNING');
        delete draft.last_error;
      } else if (remainingBlocked) {
        draft.last_error = 'retry or dynamic task budget is exhausted; resume with a larger budget or start a new run';
      } else {
        draft.last_error = 'no task can be resumed; check pending dependencies and decisions';
      }
      return draft;
    });
    await recordDecision(this.options.store, {
      run_id: runId,
      phase: 'lifecycle',
      code: state.status === 'RUNNING' ? 'resume_requested' : 'resume_blocked',
      title: state.status === 'RUNNING' ? '收到人工恢复请求' : '人工恢复未找到可调度的任务',
      detail: `运行状态：${state.status}；重新排队：${requeued.join(', ') || '(none)'}。`,
      outcome: state.status === 'RUNNING' ? 'info' : 'blocked',
      data: {
        requeued,
        overrides: {
          max_total_tokens: options.max_total_tokens ?? null,
          max_duration_hours: options.max_duration_hours ?? null,
          max_task_attempts: options.max_task_attempts ?? null,
        },
      },
    });
    if (state.status !== 'RUNNING') {
      throw new Error(state.last_error ?? 'run cannot be resumed');
    }
    return state;
  }

  async cancel(runId: string): Promise<RunState> {
    await recordDecision(this.options.store, {
      run_id: runId,
      phase: 'lifecycle',
      code: 'cancel_requested',
      title: '收到人工取消请求',
      outcome: 'info',
    });
    const state = await this.updateRun(runId, (draft) => {
      changeRun(draft, 'CANCELLED');
      draft.current_task_ids = [];
      return draft;
    });
    for (const controller of this.cancellationControllers.get(runId) ?? []) controller.abort();
    await Promise.allSettled([...(this.activeOperations.get(runId) ?? [])]);
    return await this.updateRun(runId, draft => {
      for (const task of draft.graph.tasks) {
        if (!['DONE', 'CANCELLED'].includes(task.status)) changeTask(draft, task.id, 'CANCELLED');
      }
      return draft;
    }, true);
  }

  async respond(runId: string, decisionId: string, response: string): Promise<RunState> {
    if (response.trim().length === 0) {
      throw new Error('decision response cannot be empty');
    }
    let state = await this.requireRun(runId);
    if (['COMPLETED', 'CANCELLED'].includes(state.status)) return state;
    if (!state.pending_decision_ids.includes(decisionId)) {
      throw new Error(`unknown pending decision: ${decisionId}`);
    }
    const acceptanceCondition = state.graph.acceptance?.find(
      (condition) => condition.id === decisionId,
    );
    if (acceptanceCondition?.verification.type === 'manual') {
      if (!isApprovalResponse(response)) {
        let repairTaskId: string | undefined;
        let blockedReason: string | undefined;
        state = await this.updateRun(runId, (draft) => {
          if (draft.status === 'CANCELLED') return draft;
          const dynamicTaskCount = draft.graph.tasks.filter(
            (task) => task.origin !== 'initial_plan',
          ).length;
          if (dynamicTaskCount >= draft.config.runtime.max_dynamic_tasks) {
            blockedReason = 'dynamic task budget exhausted; manual acceptance remains pending';
            draft.last_error = blockedReason;
            return draft;
          }
          const repair = createManualAcceptanceRepair(draft, decisionId, response);
          if (repair.task === undefined) {
            blockedReason = repair.exhausted ?? 'manual acceptance repair is unavailable';
            draft.last_error = blockedReason;
            return draft;
          }
          repairTaskId = repair.task.id;
          draft.graph.tasks.push(repair.task);
          draft.pending_decision_ids = draft.pending_decision_ids.filter((id) => id !== decisionId);
          if (draft.pending_decision_tasks !== undefined) {
            delete draft.pending_decision_tasks[decisionId];
          }
          draft.decision_blockers = (draft.decision_blockers ?? []).filter(
            (blocker) => blocker.decision_id !== decisionId,
          );
          draft.decisions = [
            ...(draft.decisions ?? []),
            {
              decision_id: decisionId,
              response: `rejected: ${response}`,
              answered_at: new Date().toISOString(),
            },
          ];
          if (draft.pending_decision_ids.length === 0) {
            changeRun(draft, 'RUNNING');
          }
          return draft;
        });
        await this.options.store.appendEvent(runId, {
          type: 'human_decision',
          decision_id: decisionId,
          response,
          accepted: false,
          ...(repairTaskId === undefined ? {} : { repair_task_id: repairTaskId }),
        });
        await recordDecision(this.options.store, {
          run_id: runId,
          phase: 'human',
          code: repairTaskId === undefined ? 'acceptance_repair_blocked' : 'acceptance_repair_created',
          title: repairTaskId === undefined
            ? `人工验收未通过，但无法创建返工任务：${decisionId}`
            : `人工验收未通过，已创建返工任务：${repairTaskId}`,
          detail: blockedReason ?? response,
          outcome: repairTaskId === undefined ? 'blocked' : 'fail',
          data: {
            decision_id: decisionId,
            response,
            ...(repairTaskId === undefined ? {} : { repair_task_id: repairTaskId }),
          },
        });
        return state;
      }
      // Bind the approval to the exact snapshot acceptance evaluates. Recording
      // a different snapshot silently discards the approval and re-queues the
      // same decision forever.
      const acceptedSnapshotId = acceptedContentSnapshotId(state);
      const record: EvidenceRecord = {
        id: `E-${createHash('sha256').update(`${runId}:${decisionId}:${response}`).digest('hex').slice(0, 16)}`,
        run_id: runId,
        task_id: 'ACCEPTANCE',
        acceptance_ids: [decisionId],
        code_snapshot_id: acceptedSnapshotId ?? NO_ACCEPTED_SNAPSHOT,
        command: 'manual-approval',
        cwd: state.repo_root,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        exit_code: 0,
        stdout_path: '',
        stderr_path: '',
        result: 'passed',
      };
      this.evidence.push(record);
      await this.evidenceLedger?.append(record);
      state = await this.updateRun(runId, (draft) => {
        draft.pending_decision_ids = draft.pending_decision_ids.filter((id) => id !== decisionId);
        changeRun(draft, 'VERIFYING');
        return draft;
      });
      await this.options.store.appendEvent(runId, {
        type: 'human_decision',
        decision_id: decisionId,
        response,
      });
      await recordDecision(this.options.store, {
        run_id: runId,
        phase: 'human',
        code: 'human_decision_accepted',
        title: `人工验收通过：${decisionId}`,
        detail: response,
        outcome: 'pass',
        data: { decision_id: decisionId, response },
      });
      return await this.finishOrContinueAcceptance(state);
    }

    state = await this.updateRun(runId, (draft) => {
      const affected = draft.pending_decision_tasks?.[decisionId] ?? [];
      for (const taskId of affected) {
        const task = draft.graph.tasks.find((candidate) => candidate.id === taskId);
        const stillBlocked = draft.pending_decision_ids.some(id => id !== decisionId && (draft.pending_decision_tasks?.[id] ?? []).includes(taskId));
        if (!stillBlocked && (task?.status === 'INTERRUPTED' || task?.status === 'BLOCKED')) {
          changeTask(draft, taskId, 'READY');
        }
      }
      draft.decisions = [...(draft.decisions ?? []), { decision_id: decisionId, response, answered_at: new Date().toISOString() }];
      draft.decision_blockers = (draft.decision_blockers ?? []).filter(b => b.decision_id !== decisionId);
      draft.pending_decision_ids = draft.pending_decision_ids.filter((id) => id !== decisionId);
      if (draft.pending_decision_tasks !== undefined) {
        delete draft.pending_decision_tasks[decisionId];
      }
      if (draft.pending_decision_ids.length === 0) {
        changeRun(draft, 'RUNNING');
      }
      return draft;
    });
    await this.options.store.appendEvent(runId, {
      type: 'human_decision',
      decision_id: decisionId,
      response,
    });
    await recordDecision(this.options.store, {
      run_id: runId,
      phase: 'human',
      code: 'human_decision_answered',
      title: `人工决策已记录：${decisionId}`,
      detail: response,
      outcome: 'pass',
      data: { decision_id: decisionId, response },
    });
    return state;
  }

  private async retryInterruptedTask(
    state: RunState,
    taskId: string,
    summary: string,
  ): Promise<RunState> {
    const next = await this.updateRun(state.run_id, (draft) => {
      const task = draft.graph.tasks.find((candidate) => candidate.id === taskId)!;
      changeTask(draft, taskId, 'INTERRUPTED');
      task.attempt += 1;
      const effectiveMaxAttempts = Math.min(task.max_attempts, draft.config.runtime.max_task_attempts);
      if (task.workspace_path !== undefined) task.seed_worktree = task.workspace_path;
      task.failure_context = { summary };
      draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
      if (task.attempt >= effectiveMaxAttempts) {
        changeTask(draft, taskId, 'BLOCKED');
        draft.last_error = summary;
        if (draft.status !== 'BLOCKED') {
          changeRun(draft, 'BLOCKED');
        }
      } else {
        changeTask(draft, taskId, 'READY');
      }
      return draft;
    });
    await this.options.store.appendEvent(state.run_id, {
      type: 'worker_interrupted',
      task_id: taskId,
      summary,
    });
    const task = next.graph.tasks.find((candidate) => candidate.id === taskId);
    const blocked = task?.status === 'BLOCKED';
    await recordDecision(this.options.store, {
      run_id: state.run_id,
      phase: 'execute',
      code: blocked ? 'task_blocked' : 'task_retry',
      title: blocked ? `任务已阻塞：${taskId}` : `任务将重试：${taskId}`,
      detail: summary,
      outcome: blocked ? 'blocked' : 'info',
      task_id: taskId,
      data: { attempt: task?.attempt ?? null, status: task?.status ?? null },
    });
    return next;
  }

  private async runCancellable<T>(runId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const controllers = this.cancellationControllers.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.cancellationControllers.set(runId, controllers);
    const watcher = setInterval(() => {
      void this.options.store.readRun(runId).then(state => {
        if (state?.status === 'CANCELLED') controller.abort();
      }).catch(() => controller.abort());
    }, 100);
    watcher.unref();
    const running = (async () => {
      const latest = await this.requireRun(runId);
      if (latest.status === 'CANCELLED') controller.abort();
      return await operation(controller.signal);
    })();
    const operations = this.activeOperations.get(runId) ?? new Set<Promise<unknown>>();
    operations.add(running);
    this.activeOperations.set(runId, operations);
    try { return await running; }
    finally {
      clearInterval(watcher);
      controllers.delete(controller);
      operations.delete(running);
      if (controllers.size === 0) this.cancellationControllers.delete(runId);
      if (operations.size === 0) this.activeOperations.delete(runId);
    }
  }

  private async runVerification(request: VerificationRequest): Promise<EvidenceRecord> {
    return await this.runCancellable(request.run_id, signal => this.options.verifier.run({ ...request, signal }));
  }

  private async runWorkerWithCancellation(runId: string, request: AgentRequest): Promise<AgentResult> {
    return await this.runCancellable(runId, async signal => {
      const state = await this.requireRun(runId);
      const key = request.role === 'planner' ? 'planner_profile' : request.role === 'debugger' ? 'debugger_profile' : request.role === 'reviewer' ? 'reviewer_profile' : request.role === 'acceptance' ? 'acceptance_profile' : 'implementer_profile';
      return await this.options.workers.run(request, {signal, profile: state.config.workers[key] || state.config.workers.default_profile});
    });
  }

  private async accountUsage(runId: string, tokens: number | undefined): Promise<RunState> {
    return await this.updateRun(runId, draft => ({ ...draft, total_tokens_used: (draft.total_tokens_used ?? 0) + (tokens ?? 0), ...(tokens === undefined ? { usage_incomplete: true } : {}) }), true);
  }

  private async blockTaskForViolation(
    state: RunState,
    taskId: string,
    message: string,
  ): Promise<RunState> {
    const next = await this.updateRun(state.run_id, (draft) => {
      changeTask(draft, taskId, 'BLOCKED');
      draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
      draft.last_error = message;
      if (draft.status !== 'BLOCKED') {
        changeRun(draft, 'BLOCKED');
      }
      return draft;
    });
    await this.options.store.appendEvent(state.run_id, {
      type: 'worker_scope_violation',
      task_id: taskId,
      message,
    });
    await recordDecision(this.options.store, {
      run_id: state.run_id,
      phase: 'execute',
      code: 'worker_violation',
      title: `任务被阻塞：${taskId}`,
      detail: message,
      outcome: 'blocked',
      task_id: taskId,
    });
    return next;
  }

  private async cancelTaskIfRunCancelled(
    runId: string,
    taskId: string,
  ): Promise<RunState | undefined> {
    const latest = await this.options.store.readRun(runId);
    if (latest?.status !== 'CANCELLED') {
      return undefined;
    }
    return await this.updateRun(runId, (draft) => {
      const task = draft.graph.tasks.find((candidate) => candidate.id === taskId);
      if (task !== undefined && task.status !== 'CANCELLED' && task.status !== 'DONE') {
        changeTask(draft, taskId, 'CANCELLED');
      }
      draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
      return draft;
    });
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}
