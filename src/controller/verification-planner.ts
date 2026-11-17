import type { RunState } from '../domain/types.js';

export interface VerificationCheck {
  command: string;
  expected_exit_code: number;
  acceptance_ids: string[];
}

/** Command and expected exit jointly identify a check; one command can have different contracts. */
export function compileVerificationPlan(state: RunState): VerificationCheck[] {
  const checks = new Map<string, VerificationCheck>();
  const add = (command: string, expected: number, acceptance: string[]) => {
    const key = JSON.stringify([command, expected]);
    const existing = checks.get(key);
    checks.set(key, { command, expected_exit_code: expected, acceptance_ids: [...new Set([...(existing?.acceptance_ids ?? []), ...acceptance])] });
  };
  for (const command of Object.values(state.config.verification.commands).flat()) add(command, 0, []);
  for (const condition of state.graph.acceptance ?? []) {
    if (condition.mandatory && 'command' in condition.verification) {
      add(condition.verification.command, condition.verification.expected_exit_code, [condition.id]);
    }
  }
  // Re-run every completed task's own checks at the accepted snapshot. Without
  // this, a later integration invalidates the task evidence and requirement
  // coverage can never be re-established; task-specific checks (lint,
  // targeted suites) would also never be revalidated at completion time.
  for (const task of state.graph.tasks) {
    if (task.status !== 'DONE') continue;
    for (const command of task.verification_commands) {
      const condition = (state.graph.acceptance ?? []).find(
        (candidate) =>
          task.acceptance_ids.includes(candidate.id) &&
          'command' in candidate.verification &&
          candidate.verification.command === command,
      );
      const expected = condition !== undefined && 'expected_exit_code' in condition.verification
        ? condition.verification.expected_exit_code
        : 0;
      add(command, expected, task.acceptance_ids);
    }
  }
  return [...checks.values()];
}
