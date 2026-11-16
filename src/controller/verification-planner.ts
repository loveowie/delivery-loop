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
  return [...checks.values()];
}
