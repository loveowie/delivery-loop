import type { RunState } from '../domain/types.js';

export function durationExceeded(state: RunState, now = Date.now()): boolean {
  const started = Date.parse(state.created_at);
  return Number.isFinite(started) && now - started > state.config.runtime.max_duration_hours * 3_600_000;
}

export function progressSignature(state: RunState): string {
  return JSON.stringify({
    status: state.status,
    snapshot: state.integration_snapshot_id,
    tasks: state.graph.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      attempt: task.attempt,
      failure: task.last_failure_fingerprint,
    })),
  });
}
