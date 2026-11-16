import { assertTaskTransition } from '../scheduler/state-machine.js';
import type { StateStore } from '../state/state-store.js';

export async function recoverInterruptedRun(
  store: StateStore,
  runId: string,
) {
  return await store.updateRun(runId, (state) => {
    for (const task of state.graph.tasks) {
      if (task.status === 'INTERRUPTED') {
        if ((state.pending_decision_ids ?? []).some(id => (state.pending_decision_tasks?.[id] ?? []).includes(task.id))) continue;
        assertTaskTransition('INTERRUPTED', 'READY');
        task.status = 'READY';
      } else if (['RUNNING', 'VERIFYING', 'REVIEWING', 'INTEGRATING'].includes(task.status)) {
        assertTaskTransition(task.status, 'INTERRUPTED');
        task.status = 'INTERRUPTED';
        assertTaskTransition('INTERRUPTED', 'READY');
        task.status = 'READY';
      }
    }
    state.current_task_ids = [];
    return state;
  });
}
