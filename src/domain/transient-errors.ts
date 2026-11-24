/**
 * Errors that describe a DSH lifecycle race, not a broken delivery.
 *
 * An Agent's Cordis fiber is dropped when its activation ends. Starting a
 * subagent with a parent whose context is already inactive throws
 * "cannot create effect on inactive context"; the same message is produced
 * when the Host creates a fresh coordinator underneath a context that is being
 * torn down. Both are transient: re-resolving the parent (or re-queueing the
 * in-flight task) succeeds on the next attempt.
 *
 * Keep this predicate narrow. A worker that cannot start because a provider is
 * missing, a prompt is invalid or a workspace vanished must still block the
 * run; only the teardown race is retryable.
 * @module domain/transient-errors
 */

const INACTIVE_CONTEXT = /cannot create effect on inactive context/i;

/** Whether a failure is the DSH inactive-context teardown race. */
export function isInactiveContextError(message: string): boolean {
  return INACTIVE_CONTEXT.test(message);
}
