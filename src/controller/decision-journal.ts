import type { StateStore } from '../state/state-store.js';

export type DecisionPhase =
  | 'prepare'
  | 'dispatch'
  | 'execute'
  | 'verify'
  | 'review'
  | 'integrate'
  | 'accept'
  | 'human'
  | 'lifecycle';

export type DecisionOutcome = 'info' | 'pass' | 'fail' | 'blocked' | 'waiting';

export interface DecisionRecord {
  phase: DecisionPhase;
  code: string;
  title: string;
  detail?: string;
  outcome: DecisionOutcome;
  task_id?: string;
  data?: Record<string, unknown>;
}

export interface DecisionInput extends DecisionRecord {
  run_id: string;
}

function bounded(value: string, max = 4_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function boundedData(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const rendered = JSON.stringify(value);
  if (rendered.length <= 16_000) return value;
  return { truncated: true, preview: `${rendered.slice(0, 16_000)}…` };
}

/**
 * Append one structured decision to the run's audit log.
 *
 * Decisions are ordinary events, so they survive process restarts, replay in
 * order next to the run lifecycle, and never depend on plugin memory.
 */
export async function recordDecision(
  store: StateStore,
  input: DecisionInput,
): Promise<void> {
  const { run_id: runId, ...record } = input;
  await store.appendEvent(runId, {
    type: 'decision',
    phase: record.phase,
    code: record.code,
    title: record.title,
    outcome: record.outcome,
    ...(record.detail === undefined ? {} : { detail: bounded(record.detail) }),
    ...(record.task_id === undefined ? {} : { task_id: record.task_id }),
    ...(record.data === undefined ? {} : { data: boundedData(record.data) }),
  }, { durable: false });
}

/** Remove fields that are not stable, renderable JSON from a recorded event. */
export function decisionFromEvent(event: Record<string, unknown>): DecisionRecord | undefined {
  if (event.type !== 'decision') return undefined;
  const phase = event.phase;
  const code = event.code;
  const title = event.title;
  const outcome = event.outcome;
  if (typeof phase !== 'string' || typeof code !== 'string' || typeof title !== 'string') {
    return undefined;
  }
  if (!['info', 'pass', 'fail', 'blocked', 'waiting'].includes(String(outcome))) {
    return undefined;
  }
  return {
    phase: phase as DecisionPhase,
    code,
    title,
    outcome: outcome as DecisionOutcome,
    ...(typeof event.detail === 'string' ? { detail: event.detail } : {}),
    ...(typeof event.task_id === 'string' ? { task_id: event.task_id } : {}),
    ...(event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data)
      ? { data: event.data as Record<string, unknown> }
      : {}),
  };
}
