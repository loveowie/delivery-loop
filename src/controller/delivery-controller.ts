import { changedSnapshotPaths } from '../workspace/repository-context.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeDeliveryReport } from '../reporting/report-writer.js';
import { compileVerificationPlan } from './verification-planner.js';
import { evaluateAcceptance } from './acceptance.js';
import { blockingFindings } from './review-cycle.js';
import { failureFingerprint } from '../scheduler/failure-fingerprint.js';
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
import { missingRequiredOutputs } from './required-outputs.js';

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
        if (evidence.result === 'error') return await this.blockVerificationError(latest, evidence);
      }
      state = { ...current, baseline_verification_id: baselineId };
    }
    state = await this.updateRun(runId, (draft) => {
      if (draft.status === 'CANCELLED') return draft;
      changeRun(draft, 'RUNNING');
      if (state.baseline_verification_id !== undefined) {
        draft.baseline_verification_id = state.baseline_verification_id;
      }
      return draft;
    });
    await this.options.store.appendEvent(runId, { type: 'run_started' });
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
    const beforePrepareCancelled = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
    if (beforePrepareCancelled !== undefined) return beforePrepareCancelled;
    const workspace = await this.options.worktrees.prepare(
      state,
      task,
      task.seed_worktree ?? state.integration_worktree,
    );
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
    const cancelledAfterWorker = await this.cancelTaskIfRunCancelled(state.run_id, taskId);
    if (cancelledAfterWorker !== undefined) {
      return cancelledAfterWorker;
    }
    if (result.status === 'blocked') {
      state = await this.updateRun(state.run_id, (draft) => {
        draft.pending_decision_ids = [...new Set([...draft.pending_decision_ids, ...result.blockers.map((blocker) => blocker.decision_id)])];
        draft.decision_blockers = [...(draft.decision_blockers ?? []), ...result.blockers];
        draft.pending_decision_tasks ??= {};
        for (const blocker of result.blockers) {
          draft.pending_decision_tasks[blocker.decision_id] = blocker.affected_task_ids;
        }
        changeTask(draft, taskId, 'INTERRUPTED');
        draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
        changeRun(draft, 'WAITING_HUMAN');
        return draft;
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
    if (failedEvidence?.result === 'error') return await this.blockVerificationError(state, failedEvidence, taskId);
    if (failedEvidence !== undefined) {
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

    if (taskRequiresReview(task, state.config)) {
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
        state = await this.updateRun(state.run_id, (draft) => {
          changeTask(draft, taskId, 'INTERRUPTED');
          draft.pending_decision_ids = [...new Set([...draft.pending_decision_ids, ...reviewResult.blockers.map((blocker) => blocker.decision_id)])];
          draft.decision_blockers = [...(draft.decision_blockers ?? []), ...reviewResult.blockers];
          draft.pending_decision_tasks ??= {};
          for (const blocker of reviewResult.blockers) {
            draft.pending_decision_tasks[blocker.decision_id] = blocker.affected_task_ids;
          }
          draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
          changeRun(draft, 'WAITING_HUMAN');
          return draft;
        });
        return state;
      }
      if (reviewResult.status === 'failed') {
        state = await this.retryInterruptedTask(state, taskId, reviewResult.summary);
        return state;
      }
      const blocking = blockingFindings(reviewResult, state.config.review);
      if (blocking.length > 0) {
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

    state = await this.updateRun(state.run_id, (draft) => {
      changeTask(draft, taskId, 'DONE');
      const completedTask = draft.graph.tasks.find((candidate) => candidate.id === taskId)!;
      if (completedTask.repairs_task_id !== undefined) {
        const source = draft.graph.tasks.find(
          (candidate) => candidate.id === completedTask.repairs_task_id,
        );
        if (source?.status === 'FIX_REQUIRED') {
          changeTask(draft, source.id, 'PENDING');
          delete source.seed_worktree;
          delete source.failure_context;
        }
      }
      draft.current_task_ids = draft.current_task_ids.filter((id) => id !== taskId);
      return draft;
    });
    await this.options.store.appendEvent(state.run_id, { type: 'task_done', task_id: taskId });
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
    if (state.config.review.final_review) {
      const finalReview = state.graph.tasks.find((task) => task.id === 'FINAL-REVIEW');
      if (finalReview === undefined) {
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
            max_attempts: 1,
            verification_commands: [],
            review_policy: 'none',
          });
          return draft;
        });
      }
      if (finalReview.status === 'DONE' && finalReview.code_snapshot_id !== state.integration_snapshot_id) {
        return await this.updateRun(state.run_id, draft => {
          changeTask(draft, 'FINAL-REVIEW', 'READY');
          if (draft.status === 'VERIFYING') changeRun(draft, 'RUNNING');
          return draft;
        });
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
        if (evidence.result === 'error') return await this.blockVerificationError(state, evidence);
        if (evidence.result !== 'passed') {
          return await this.updateRun(state.run_id, (draft) => {
            if (draft.status === 'CANCELLED') return draft;
            const sources = draft.graph.tasks.filter(task => task.origin === 'initial_plan' && task.worker_role !== 'reviewer' && task.worker_role !== 'acceptance' && (check.acceptance_ids.some(id => task.acceptance_ids.includes(id)) || task.verification_commands.includes(check.command)));
            const source = sources.length === 1 ? sources[0] : undefined;
            const dynamicTaskCount = draft.graph.tasks.filter(task => task.origin !== 'initial_plan').length;
            const effectiveMaxAttempts = source === undefined ? 0 : Math.min(source.max_attempts, draft.config.runtime.max_task_attempts);
            const priorAcceptanceRepair = source !== undefined && draft.graph.tasks.some(task => task.origin === 'acceptance_gap' && task.verification_commands.includes(check.command) && task.repairs_task_id === source.id && task.status !== 'CANCELLED');
            if (source === undefined || source.attempt + 1 >= effectiveMaxAttempts || priorAcceptanceRepair || dynamicTaskCount >= draft.config.runtime.max_dynamic_tasks || (source.dynamic_depth ?? 0) >= draft.config.runtime.max_dynamic_depth) {
              draft.last_error = 'final verification failed; repair target unavailable, duplicate repair, or budget exhausted';
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
      state = await this.updateRun(state.run_id, (draft) => {
        draft.final_verification_snapshot_id = integrationSnapshotId;
        return draft;
      });
    }
    const latestSnapshot = state.integration_snapshot_id ?? state.graph.tasks.at(-1)?.code_snapshot_id;
    const persistedEvidence = await this.evidenceLedger?.readAll(state.run_id);
    const result = evaluateAcceptance(
      state.graph,
      persistedEvidence ?? this.evidence,
      latestSnapshot,
    );
    if (result.status === 'WAITING_HUMAN') {
      return await this.updateRun(state.run_id, (draft) => {
        changeRun(draft, 'WAITING_HUMAN');
        const decisionIds = (draft.graph.acceptance ?? [])
          .filter(
            (condition) =>
              condition.mandatory &&
              condition.verification.type !== 'command' &&
              condition.verification.type !== 'test',
          )
          .map((condition) => condition.id);
        draft.pending_decision_ids =
          decisionIds.length > 0
            ? decisionIds
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
      const currentEvidence = (persistedEvidence ?? this.evidence).filter(record => record.code_snapshot_id === latestSnapshot);
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
      return await this.updateRun(state.run_id, (draft) => {
        for (const requirement of draft.graph.requirements ?? []) {
          requirement.status = 'SATISFIED';
        }
        draft.completion_ref = { path: certificatePath, sha256: createHash('sha256').update(certificate).digest('hex') };
        changeRun(draft, 'COMPLETED');
        return draft;
      });
    }

    return await this.updateRun(state.run_id, (draft) => {
      draft.last_error = `acceptance evidence unavailable: ${result.reasons.join('; ')}`;
      changeRun(draft, 'BLOCKED');
      return draft;
    });
  }

  async pause(runId: string): Promise<RunState> {
    return await this.updateRun(runId, (draft) => {
      draft.pause_requested = true;
      return draft;
    });
  }

  async resume(runId: string): Promise<RunState> {
    return await this.updateRun(runId, (draft) => {
      draft.pause_requested = false;
      if (draft.status === 'PAUSED' || draft.status === 'BLOCKED' || draft.status === 'QUEUED') {
        for (const task of draft.graph.tasks) {
          const unresolved = draft.pending_decision_ids.some(id => (draft.pending_decision_tasks?.[id] ?? []).includes(task.id));
          if (task.status === 'BLOCKED' && task.failure_context?.evidence?.result === 'error' && !unresolved) {
            if (task.workspace_path !== undefined) task.seed_worktree = task.workspace_path;
            changeTask(draft, task.id, 'READY');
          }
        }
        changeRun(draft, 'RUNNING');
      }
      return draft;
    });
  }

  async cancel(runId: string): Promise<RunState> {
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
      const normalized = response.trim().toLowerCase();
      if (!['approve', 'approved', 'yes', 'confirm', 'confirmed', '通过', '确认', '同意'].includes(normalized)) {
        await this.options.store.appendEvent(runId, {
          type: 'human_decision',
          decision_id: decisionId,
          response,
          accepted: false,
        });
        return state;
      }
      const record: EvidenceRecord = {
        id: `E-${createHash('sha256').update(`${runId}:${decisionId}:${response}`).digest('hex').slice(0, 16)}`,
        run_id: runId,
        task_id: 'ACCEPTANCE',
        acceptance_ids: [decisionId],
        code_snapshot_id: state.integration_snapshot_id ?? 'NO-INTEGRATION-SNAPSHOT',
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
