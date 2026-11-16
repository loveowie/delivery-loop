import type { EvidenceRecord, TaskGraph } from '../domain/types.js';

export interface AcceptanceResult {
  status: 'PASSED' | 'FAILED' | 'WAITING_HUMAN';
  reasons: string[];
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
  const hasRequirementEvidence = (requirementId: string): boolean => graph.tasks.some(task =>
    task.requirement_ids.includes(requirementId) && evidence.some(record =>
      record.task_id === task.id && record.result === 'passed' &&
      (currentSnapshotId === undefined || record.code_snapshot_id === currentSnapshotId),
    ),
  );
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
