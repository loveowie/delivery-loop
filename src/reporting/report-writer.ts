import { StateStore } from '../state/state-store.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunState, EvidenceRecord } from '../domain/types.js';
import type { FinalizationJournal } from '../finalize/finalizer.js';

function tableCell(value: unknown): string {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
}

function taskTable(state: RunState): string {
  if (state.graph.tasks.length === 0) {
    return '_No tasks._';
  }
  return [
    '| Task | Type | Status | Attempt | Failures |',
    '| --- | --- | --- | ---: | --- |',
    ...state.graph.tasks.map(
      (task) =>
        `| ${tableCell(task.id)} | ${tableCell(task.type)} | ${tableCell(task.status)} | ${tableCell(task.attempt)} | ${tableCell(task.last_failure_fingerprint)} |`,
    ),
  ].join('\n');
}

function requirementTable(state: RunState): string {
  const requirements = state.graph.requirements ?? [];
  if (requirements.length === 0) {
    return '_No structured requirements._';
  }
  return [
    '| Requirement | Status | Description |',
    '| --- | --- | --- |',
    ...requirements.map(
      (requirement) =>
        `| ${tableCell(requirement.id)} | ${tableCell(requirement.status)} | ${tableCell(requirement.description)} |`,
    ),
  ].join('\n');
}

async function readFinalizationJournal(
  store: StateStore,
  runId: string,
): Promise<FinalizationJournal | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(store.getRunDirectory(runId), 'finalization', 'journal.json'), 'utf8'),
    ) as Partial<FinalizationJournal>;
    if (
      parsed.version !== 1 ||
      parsed.run_id !== runId ||
      !['commit', 'branch', 'push', 'merge'].includes(parsed.action ?? '') ||
      !['intent', 'completed'].includes(parsed.status ?? '')
    ) {
      throw new Error(`invalid finalization journal for run: ${runId}`);
    }
    return parsed as FinalizationJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function finalizationSection(journal: FinalizationJournal | undefined): string[] {
  if (journal === undefined) {
    return ['No finalization record exists for this run.'];
  }
  const lines = [
    `- Finalization status: **${journal.status}**`,
    `- Finalization action: \`${journal.action}\``,
  ];
  const result = journal.result ?? {};
  if (Object.keys(result).length === 0) {
    lines.push('', '_No finalization result has been recorded._');
    return lines;
  }
  lines.push(
    '',
    '| Result | Value |',
    '| --- | --- |',
    ...Object.entries(result).map(([key, value]) => `| ${tableCell(key)} | ${tableCell(value)} |`),
  );
  return lines;
}

export async function writeDeliveryReport(repoRoot: string, state: RunState, evidence: EvidenceRecord[] = []): Promise<string> {
  const store = await StateStore.open(repoRoot);
  const finalizationJournal = await readFinalizationJournal(store, state.run_id);
  const content = [
    `# Delivery Report: ${state.run_id}`,
    '',
    `- Status: **${state.status}**`,
    `- Repository: \`${state.repo_root}\``,
    `- Created: ${state.created_at}`,
    `- Updated: ${state.updated_at}`,
    `- Code snapshot: ${state.integration_snapshot_id ?? 'not generated'}`,
    `- Git mode: \`${state.config.git.mode}\``,
    '',
    '## Requirements',
    '',
    requirementTable(state),
    '',
    '## Tasks',
    '',
    taskTable(state),
    '',
    '## Verification evidence',
    '',
    '| Check | Snapshot | Result | Evidence |',
    '| --- | --- | --- | --- |',
    ...evidence.map(record => `| ${tableCell(record.command)} | ${tableCell(record.code_snapshot_id)} | ${tableCell(record.result)} | ${tableCell(record.id)} |`),
    '',
    '## Delivery Artifact',
    '',
    ...finalizationSection(finalizationJournal),
    '',
  ].join('\n');
  return await store.writeArtifact(state.run_id, 'reports/final.md', content);
}
