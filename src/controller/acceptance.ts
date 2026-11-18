import type { EvidenceRecord, RunState, TaskGraph } from '../domain/types.js';

export interface AcceptanceResult {
  status: 'PASSED' | 'FAILED' | 'WAITING_HUMAN';
  reasons: string[];
}

/**
 * Snapshot placeholder used when a run never produced accepted content (for
 * example a pure approval delivery with no tasks at all).
 */
export const NO_ACCEPTED_SNAPSHOT = 'NO-INTEGRATION-SNAPSHOT';

/**
 * The single source of truth for "the content this run has accepted".
 *
 * Acceptance evaluation and manual approval evidence must bind to the same
 * value: when `respond` recorded a different snapshot than the acceptance
 * evaluator used, the approval was silently discarded and re-queued forever.
 * Approval-only deliveries (no integration performed) fall back to the last
 * task snapshot so their approval still matches.
 */
export function acceptedContentSnapshotId(state: RunState): string | undefined {
  return state.integration_snapshot_id ?? state.graph.tasks.at(-1)?.code_snapshot_id;
}

export function evaluateAcceptance(
  graph: TaskGraph,
  evidence: EvidenceRecord[],
  currentSnapshotId?: string,
): AcceptanceResult {
  const acceptance = graph.acceptance ?? [];
  const requirements = graph.requirements ?? [];
  if (requirements.length === 0 && !acceptance.some(condition => condition.mandatory)) {
    return { status: 'FAILED', reasons: ['delivery contract has no requirement or mandatory acceptance'] };
  }
  const evidenceIsCurrent = (record: EvidenceRecord): boolean =>
    record.result === 'passed' &&
    (currentSnapshotId === undefined || record.code_snapshot_id === currentSnapshotId);

  /**
   * A requirement is evidenced when every check of at least one completed task
   * covering it has passed at the current snapshot. Matching by command (not by
   * task id) lets the final verification matrix re-establish requirement
   * coverage after later integrations; the previous per-task-id match made any
   * non-final task's evidence permanently stale.
   */
  const hasRequirementEvidence = (requirementId: string): boolean =>
    graph.tasks.some((task) => {
      if (!task.requirement_ids.includes(requirementId) || task.status !== 'DONE') return false;
      if (task.verification_commands.length === 0) return false;
      return task.verification_commands.every((command) =>
        evidence.some((record) => record.command === command && evidenceIsCurrent(record)),
      );
    });
  if (acceptance.length === 0) {
    const unsatisfied = requirements.filter(requirement => !hasRequirementEvidence(requirement.id));
    return unsatisfied.length === 0 ? { status: 'PASSED', reasons: [] } : {
      status: 'FAILED', reasons: unsatisfied.map(requirement => `requirement ${requirement.id} has no current independent evidence`),
    };
  }

  const waiting: string[] = [];
  const failed: string[] = [];
  for (const condition of acceptance.filter((candidate) => candidate.mandatory)) {
    if (condition.verification.type === 'manual') {
      const approval = evidence.some(
        (record) =>
          record.acceptance_ids.includes(condition.id) &&
          record.command === 'manual-approval' &&
          record.result === 'passed' &&
          (currentSnapshotId === undefined || record.code_snapshot_id === currentSnapshotId),
      );
      if (!approval) {
        waiting.push(`manual acceptance ${condition.id} requires user confirmation`);
      }
      continue;
    }
    if (condition.verification.type === 'artifact' || condition.verification.type === 'review') {
      const matching = evidence.some(
        (record) =>
          record.acceptance_ids.includes(condition.id) &&
          (condition.verification.type === 'review'
            ? record.command === 'independent-review'
            : record.command === 'artifact-check') &&
          record.result === 'passed' &&
          (currentSnapshotId === undefined || record.code_snapshot_id === currentSnapshotId),
      );
      if (!matching) {
        failed.push(`acceptance ${condition.id} has no current passing evidence`);
      }
      continue;
    }

    const matching = evidence.find(
      (record) =>
        record.acceptance_ids.includes(condition.id) &&
        'command' in condition.verification &&
        record.command === condition.verification.command &&
        'expected_exit_code' in condition.verification &&
        record.exit_code === condition.verification.expected_exit_code &&
        record.result === 'passed' &&
        (currentSnapshotId === undefined || record.code_snapshot_id === currentSnapshotId),
    );
    if (matching === undefined) {
      failed.push(`acceptance ${condition.id} has no current passing evidence`);
    }
  }

  if (waiting.length > 0) {
    return { status: 'WAITING_HUMAN', reasons: [...waiting, ...failed] };
  }
  if (failed.length > 0) {
    return { status: 'FAILED', reasons: failed };
  }

  const requirementsWithAcceptance = new Set(
    acceptance.filter(condition => condition.mandatory).map((condition) => condition.requirement_id),
  );
  for (const requirement of requirements) {
    if (
      !requirementsWithAcceptance.has(requirement.id) && !hasRequirementEvidence(requirement.id)
    ) {
      failed.push(`requirement ${requirement.id} is not satisfied`);
    }
  }
  return failed.length === 0
    ? { status: 'PASSED', reasons: [] }
    : { status: 'FAILED', reasons: failed };
}
