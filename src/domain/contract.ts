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

  const requirements = graph.requirements ?? [];
  const acceptance = graph.acceptance ?? [];
  const mandatoryAcceptance = acceptance.filter((condition) => condition.mandatory);

  // An empty contract makes every task finish while `evaluateAcceptance` keeps
  // returning FAILED, so the run becomes permanently BLOCKED with no way to
  // resume. Reject it at preparation/start instead of discovering it after all
  // work is done.
  if (requirements.length === 0 && mandatoryAcceptance.length === 0) {
    errors.push(
      'delivery contract has no requirement and no mandatory acceptance; declare at least one requirement covered by a mandatory acceptance or a task verification command',
    );
  } else if (requirements.length === 0) {
    errors.push(
      'delivery contract must declare at least one requirement; mandatory acceptance conditions cannot stand alone',
    );
  }

  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  for (const condition of mandatoryAcceptance) {
    if (!requirementIds.has(condition.requirement_id)) {
      errors.push(
        `mandatory acceptance ${condition.id} references unknown requirement ${condition.requirement_id}`,
      );
    }
  }

  // Every requirement must have a path to satisfaction: a mandatory acceptance
  // condition, or a covering task whose verification command the final matrix
  // can re-run at the accepted snapshot. Manual-only (pure human approval)
  // contracts are valid because the mandatory acceptance counts as coverage.
  for (const requirement of requirements) {
    const coveredByAcceptance = mandatoryAcceptance.some(
      (condition) => condition.requirement_id === requirement.id,
    );
    const coveredByTask = graph.tasks.some(
      (task) =>
        task.requirement_ids.includes(requirement.id) && task.verification_commands.length > 0,
    );
    if (!coveredByAcceptance && !coveredByTask) {
      errors.push(
        `requirement ${requirement.id} is not covered by a mandatory acceptance condition or a task with a verification command`,
      );
    }
  }

  const reviewConditions = mandatoryAcceptance.filter(
    (condition) => condition.verification.type === 'review',
  );
  if (reviewConditions.length > 0 && !config.review.final_review) {
    errors.push(
      `mandatory review acceptance (${reviewConditions.map((condition) => condition.id).join(', ')}) requires review.final_review=true`,
    );
  }
  return errors;
}
