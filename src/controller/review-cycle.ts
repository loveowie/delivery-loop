import type { AgentResult, ReviewConfig } from '../domain/types.js';

export function blockingFindings(result: AgentResult, config: ReviewConfig) {
  return result.findings.filter((finding) => config.blocking_severities.includes(finding.severity));
}
