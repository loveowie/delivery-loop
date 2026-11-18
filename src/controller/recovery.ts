import { assertRunTransition, assertTaskTransition } from '../scheduler/state-machine.js';
import type { StateStore } from '../state/state-store.js';
import type { RunState, TaskNode, TaskStatus } from '../domain/types.js';
import { recordDecision } from './decision-journal.js';

const IN_FLIGHT_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'RUNNING',
  'VERIFYING',
  'REVIEWING',
  'INTEGRATING',
]);

function unresolvedDecisionTasks(state: RunState): Set<string> {
  const unresolved = new Set<string>();
  for (const decisionId of state.pending_decision_ids ?? []) {
    for (const taskId of state.pending_decision_tasks?.[decisionId] ?? []) {
      unresolved.add(taskId);
    }
  }
  return unresolved;
}

function effectiveMaxAttempts(state: RunState, task: TaskNode): number {
  return Math.min(task.max_attempts, state.config.runtime.max_task_attempts);
}

/**
 * Adopt tasks that were in flight when their controller died.
 *
 * Every adopted task consumes one attempt, exactly like a worker failure. A
 * crash loop must not be able to retry forever: once the budget is exhausted
 * the task and the run are blocked with an explainable decision.
 */
export async function recoverInterruptedRun(
  store: StateStore,
  runId: string,
): Promise<RunState> {
  const exhausted: Array<{ task_id: string; attempt: number }> = [];
  const state = await store.updateRun(runId, (draft) => {
    const unresolved = unresolvedDecisionTasks(draft);
    for (const task of draft.graph.tasks) {
      if (unresolved.has(task.id)) continue;
      if (task.status === 'INTERRUPTED') {
        assertTaskTransition('INTERRUPTED', 'READY');
        task.status = 'READY';
      } else if (IN_FLIGHT_TASK_STATUSES.has(task.status)) {
        assertTaskTransition(task.status, 'INTERRUPTED');
        task.status = 'INTERRUPTED';
        if (task.workspace_path !== undefined) task.seed_worktree = task.workspace_path;
        task.attempt += 1;
        if (task.attempt >= effectiveMaxAttempts(draft, task)) {
          assertTaskTransition('INTERRUPTED', 'BLOCKED');
          task.status = 'BLOCKED';
          exhausted.push({ task_id: task.id, attempt: task.attempt });
        } else {
          assertTaskTransition('INTERRUPTED', 'READY');
          task.status = 'READY';
        }
      }
    }
    draft.current_task_ids = [];
    if (exhausted.length > 0) {
      draft.last_error = `task retry budget exhausted during recovery: ${exhausted
        .map((entry) => `${entry.task_id} (attempt ${entry.attempt})`)
        .join(', ')}`;
      if (draft.status !== 'BLOCKED' && draft.status !== 'PAUSED') {
        assertRunTransition(draft.status, 'BLOCKED');
        draft.status = 'BLOCKED';
      }
    }
    return draft;
  });

  for (const entry of exhausted) {
    await recordDecision(store, {
      run_id: runId,
      phase: 'lifecycle',
      code: 'recovery_attempts_exhausted',
      title: `恢复中断任务时重试预算耗尽：${entry.task_id}`,
      detail: `任务已尝试 ${entry.attempt} 次，达到上限；请提高 max_task_attempts 或新建运行。`,
      outcome: 'blocked',
      task_id: entry.task_id,
      data: { attempt: entry.attempt },
    });
  }
  return state;
}

/**
 * Turn a run that nobody owns anymore into a durable PAUSED state.
 *
 * A pause request that survives a Host crash used to be a permanent latch: the
 * run stayed RUNNING + pause_requested with no loop and no worker lock, kept
 * occupying a repository write slot, and `wake` refused to touch it. Resetting
 * the in-flight tasks makes the run resumable later; pausing is a deliberate
 * human action, so it does not consume retry budget.
 */
export async function recoverPausedRun(
  store: StateStore,
  runId: string,
): Promise<RunState> {
  return await store.updateRun(runId, (draft) => {
    const unresolved = unresolvedDecisionTasks(draft);
    for (const task of draft.graph.tasks) {
      if (!IN_FLIGHT_TASK_STATUSES.has(task.status)) continue;
      if (unresolved.has(task.id)) continue;
      assertTaskTransition(task.status, 'INTERRUPTED');
      task.status = 'INTERRUPTED';
      if (task.workspace_path !== undefined) task.seed_worktree = task.workspace_path;
      assertTaskTransition('INTERRUPTED', 'READY');
      task.status = 'READY';
    }
    draft.current_task_ids = [];
    draft.pause_requested = true;
    if (draft.status !== 'PAUSED') {
      assertRunTransition(draft.status, 'PAUSED');
      draft.status = 'PAUSED';
    }
    return draft;
  });
}
