import type { DeliveryConfig, TaskGraph } from './types.js';

/**
 * Cross-checks between the prepared task graph and the frozen run config.
 *
 * These invariants cannot be checked by `validateTaskGraph` alone because they
 * depend on configuration, but discovering them mid-run would turn a simple
 * contract mistake into an unrecoverable BLOCKED state.
 */
export function validateDeliveryContract(
  graph: TaskGraph,
  config: DeliveryConfig,
): string[] {
  const errors: string[] = [];
  for (const task of graph.tasks) {
    if (task.capability_profile !== config.profile) {
      errors.push(
        `task ${task.id} capability_profile ${task.capability_profile} does not match run profile ${config.profile}`,
      );
    }
  }
  const reviewConditions = (graph.acceptance ?? []).filter(
    (condition) => condition.mandatory && condition.verification.type === 'review',
  );
  if (reviewConditions.length > 0 && !config.review.final_review) {
    errors.push(
      `mandatory review acceptance (${reviewConditions.map((condition) => condition.id).join(', ')}) requires review.final_review=true`,
    );
  }
  return errors;
}
