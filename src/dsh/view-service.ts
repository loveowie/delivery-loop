import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { EvidenceLedger } from '../state/evidence-ledger.js';
import { StateStore } from '../state/state-store.js';
import { RunRegistry } from '../runtime/run-registry.js';
import { createNodeGitExecutor } from '../workspace/git-adapter.js';
import { decisionFromEvent } from '../controller/decision-journal.js';
import type { DecisionPhase, DecisionOutcome } from '../controller/decision-journal.js';
import type { EvidenceRecord, RunState, TaskNode } from '../domain/types.js';

const FILE_READ_LIMIT = 512 * 1024;
const ARTIFACT_LIMIT = 400;
const EVENT_LIMIT = 800;
const SKIP_ARTIFACT_DIRECTORIES = new Set(['worktrees', 'runtime-skills']);

export interface RunSummary {
  run_id: string;
  status: RunState['status'];
  repo_root: string;
  created_at: string;
  updated_at: string;
  title: string;
  task_counts: Record<string, number>;
  total_tasks: number;
  done_tasks: number;
  active_tasks: number;
  current_task_ids: string[];
  pending_decision_ids: string[];
  last_error: string | null;
  total_tokens_used: number;
  usage_incomplete: boolean;
  integration_snapshot_id: string | null;
  completion_ref: RunState['completion_ref'] | null;
}

export interface TimelineDecision {
  id: string;
  timestamp: string;
  phase: DecisionPhase | 'system';
  code: string;
  title: string;
  detail: string | null;
  outcome: DecisionOutcome | 'info';
  task_id: string | null;
  data: Record<string, unknown> | null;
  pending?: boolean;
  options?: string[];
}

export interface TaskView {
  id: string;
  type: TaskNode['type'];
  title: string;
  status: TaskNode['status'];
  priority: string;
  risk: string;
  origin: string;
  worker_role: string;
  attempt: number;
  max_attempts: number;
  depends_on: string[];
  scope_paths: string[];
  requirement_ids: string[];
  acceptance_ids: string[];
  verification_commands: string[];
  changed_files: string[];
  last_summary: string | null;
  failure_context: TaskNode['failure_context'] | null;
  workspace_path: string | null;
  code_snapshot_id: string | null;
  repairs_task_id: string | null;
}

export interface ArtifactEntry {
  path: string;
  size: number;
  modified_at: string;
  kind: 'text' | 'json' | 'markdown' | 'log' | 'other';
}

export interface RunDetail extends RunSummary {
  spec_excerpt: string;
  config: RunState['config'];
  tasks: TaskView[];
  requirements: NonNullable<RunState['graph']['requirements']>;
  acceptance: NonNullable<RunState['graph']['acceptance']>;
  decisions: TimelineDecision[];
  events: Array<{
    id: string;
    timestamp: string;
    type: string;
    task_id: string | null;
    message: string | null;
  }>;
  evidence: EvidenceRecord[];
  files: {
    worktree: string | null;
    baseline_commit: string | null;
    changed: string[];
    tasks: Array<{ task_id: string; title: string; status: string; paths: string[]; workspace_path: string | null }>;
  };
  artifacts: ArtifactEntry[];
  decision_blockers: NonNullable<RunState['decision_blockers']>;
}

export interface FilePreview {
  path: string;
  source: 'worktree' | 'repo' | 'artifact';
  content: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

function assertSafeRelativePath(path: string): void {
  if (path.length === 0 || path.includes('\0')) throw new Error('invalid file path');
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error('file path must be relative');
  if (normalized.split('/').includes('..')) throw new Error('file path cannot escape its root');
  if (normalized === '.git' || normalized.startsWith('.git/')) throw new Error('the git directory is not readable');
}

async function canonicalRepoRoot(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    const result = await createNodeGitExecutor()(['rev-parse', '--show-toplevel'], resolved);
    const top = result.stdout.trim();
    if (result.exitCode === 0 && top.length > 0) return resolve(top);
  } catch {
    // Non-Git directories still expose their own .delivery state.
  }
  return resolved;
}

async function readBoundedFile(root: string, path: string, limit: number): Promise<FilePreview> {
  assertSafeRelativePath(path);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('file path escapes its root');
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const realRelative = relative(realRoot, realTarget);
  if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
    throw new Error('file path escapes its root through a symlink');
  }
  const details = await stat(realTarget);
  if (!details.isFile()) throw new Error('path is not a regular file');
  const buffer = await readFile(realTarget);
  const binary = buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0);
  const content = binary ? '' : buffer.subarray(0, limit).toString('utf8');
  return {
    path,
    source: 'worktree',
    content: content.replaceAll('\r\n', '\n'),
    truncated: buffer.length > limit,
    binary,
    size: buffer.length,
  };
}

function kindOf(path: string): ArtifactEntry['kind'] {
  if (path.endsWith('.json')) return 'json';
  if (/\.(md|markdown)$/.test(path)) return 'markdown';
  if (/\.(log|txt)$/.test(path)) return 'log';
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|sh|css|html|yml|yaml|toml)$/.test(path)) return 'text';
  return 'other';
}

function summarizeTitle(spec: string, runId: string): string {
  const heading = spec.split('\n').find((line) => line.trim().startsWith('#'));
  if (heading !== undefined) {
    const title = heading.replace(/^#+\s*/, '').trim();
    if (title.length > 0) return title.slice(0, 140);
  }
  return runId;
}

function countTasks(state: RunState): { counts: Record<string, number>; done: number; active: number } {
  const counts: Record<string, number> = {};
  for (const task of state.graph.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  // Cancelled tasks are resolved, not completed: a cancelled run must never read 100%.
  const done = counts.DONE ?? 0;
  const active = (counts.RUNNING ?? 0) + (counts.VERIFYING ?? 0) + (counts.REVIEWING ?? 0) + (counts.INTEGRATING ?? 0);
  return { counts, done, active };
}

async function summarize(store: StateStore, state: RunState): Promise<RunSummary> {
  const counts = countTasks(state);
  let spec = '';
  try {
    spec = await readFile(join(store.getRunDirectory(state.run_id), 'spec.md'), 'utf8');
  } catch {
    // A run without a spec is still listable.
  }
  return {
    run_id: state.run_id,
    status: state.status,
    repo_root: state.repo_root,
    created_at: state.created_at,
    updated_at: state.updated_at,
    title: summarizeTitle(spec, state.run_id),
    task_counts: counts.counts,
    total_tasks: state.graph.tasks.length,
    done_tasks: counts.done,
    active_tasks: counts.active,
    current_task_ids: state.current_task_ids,
    pending_decision_ids: state.pending_decision_ids,
    last_error: state.last_error ?? null,
    total_tokens_used: state.total_tokens_used ?? 0,
    usage_incomplete: state.usage_incomplete ?? false,
    integration_snapshot_id: state.integration_snapshot_id ?? null,
    completion_ref: state.completion_ref ?? null,
  };
}

async function listArtifacts(root: string, current = root, depth = 0): Promise<ArtifactEntry[]> {
  if (depth > 4) return [];
  const entries: ArtifactEntry[] = [];
  let directoryEntries;
  try {
    directoryEntries = await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of directoryEntries) {
    if (entries.length >= ARTIFACT_LIMIT) break;
    if (depth === 0 && SKIP_ARTIFACT_DIRECTORIES.has(entry.name)) continue;
    const target = join(current, entry.name);
    if (entry.isDirectory()) {
      entries.push(...await listArtifacts(root, target, depth + 1));
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const details = await stat(target);
      entries.push({
        path: relative(root, target).replaceAll('\\', '/'),
        size: details.size,
        modified_at: details.mtime.toISOString(),
        kind: kindOf(entry.name),
      });
    } catch {
      // A file can disappear while the directory is listed.
    }
  }
  return entries;
}

async function gitChangedFiles(worktree: string, baseline: string | undefined): Promise<string[]> {
  const exec = createNodeGitExecutor();
  const changed = new Set<string>();
  try {
    const status = await exec(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree);
    for (const entry of status.stdout.split('\0')) {
      if (entry.length > 3) changed.add(entry.slice(3));
    }
  } catch {
    // The integration worktree can be removed after completion.
  }
  if (baseline !== undefined) {
    try {
      const diff = await exec(['diff', '--name-only', '-z', baseline], worktree);
      for (const path of diff.stdout.split('\0')) if (path.length > 0) changed.add(path);
    } catch {
      // A shallow or rebased repository may not retain the baseline commit.
    }
  }
  return [...changed]
    .filter((path) => path !== '.delivery' && !path.startsWith('.delivery/'))
    .sort();
}

function timeline(events: Array<Record<string, unknown>>, state: RunState): TimelineDecision[] {
  const decisions: TimelineDecision[] = [];
  const answered = new Set<string>();
  for (const event of events) {
    const parsed = decisionFromEvent(event);
    if (parsed === undefined) continue;
    const decisionId = parsed.data?.decision_id;
    if (typeof decisionId === 'string') answered.add(decisionId);
    decisions.push({
      id: String(event.event_id ?? `${parsed.code}-${decisions.length}`),
      timestamp: String(event.timestamp ?? ''),
      phase: parsed.phase,
      code: parsed.code,
      title: parsed.title,
      detail: parsed.detail ?? null,
      outcome: parsed.outcome,
      task_id: parsed.task_id ?? null,
      data: parsed.data ?? null,
    });
  }
  // Older runs recorded only the raw human decision event.
  for (const event of events) {
    if (event.type !== 'human_decision') continue;
    const decisionId = String(event.decision_id ?? '');
    if (decisionId.length === 0 || answered.has(decisionId)) continue;
    answered.add(decisionId);
    decisions.push({
      id: String(event.event_id ?? `human-${decisionId}`),
      timestamp: String(event.timestamp ?? ''),
      phase: 'human',
      code: 'human_decision',
      title: `人工决策：${decisionId}`,
      detail: String(event.response ?? ''),
      outcome: event.accepted === false ? 'fail' : 'pass',
      task_id: null,
      data: { decision_id: decisionId, response: String(event.response ?? '') },
    });
  }
  for (const blocker of state.decision_blockers ?? []) {
    decisions.push({
      id: `pending-${blocker.decision_id}`,
      timestamp: state.updated_at,
      phase: 'human',
      code: 'pending_decision',
      title: blocker.question,
      detail: `影响任务：${blocker.affected_task_ids.join(', ') || '(整个运行)'}`,
      outcome: 'waiting',
      task_id: blocker.affected_task_ids[0] ?? null,
      data: { decision_id: blocker.decision_id, type: blocker.type },
      pending: true,
      options: blocker.options,
    });
  }
  const knownBlockers = new Set((state.decision_blockers ?? []).map((blocker) => blocker.decision_id));
  for (const decisionId of state.pending_decision_ids) {
    if (knownBlockers.has(decisionId)) continue;
    decisions.push({
      id: `pending-${decisionId}`,
      timestamp: state.updated_at,
      phase: 'human',
      code: 'pending_decision',
      title: `等待人工确认：${decisionId}`,
      detail: '该决策没有附带结构化问题，请查看运行状态与验收条件。',
      outcome: 'waiting',
      task_id: null,
      data: { decision_id: decisionId, type: 'acceptance' },
      pending: true,
      options: ['approve', 'reject'],
    });
  }
  return decisions.sort((left, right) => {
    const leftPending = left.pending === true ? 0 : 1;
    const rightPending = right.pending === true ? 0 : 1;
    if (leftPending !== rightPending) return leftPending - rightPending;
    return left.timestamp.localeCompare(right.timestamp);
  });
}

function eventMessage(event: Record<string, unknown>): string | null {
  for (const key of ['message', 'summary', 'title', 'type']) {
    const value = event[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export class DeliveryViewService {
  private readonly registry: RunRegistry;

  constructor(registry: RunRegistry = new RunRegistry()) {
    this.registry = registry;
  }

  async resolveRepoRoot(runId: string, repoRoot?: string): Promise<string> {
    if (repoRoot !== undefined && repoRoot.length > 0) return await canonicalRepoRoot(repoRoot);
    const registered = await this.registry.lookup(runId);
    if (registered === undefined) throw new Error(`run not found in registry: ${runId}`);
    return await canonicalRepoRoot(registered);
  }

  async listRuns(repoRoot?: string): Promise<RunSummary[]> {
    if (repoRoot !== undefined && repoRoot.length > 0) {
      const root = await canonicalRepoRoot(repoRoot);
      try {
        await access(join(root, '.delivery'));
      } catch {
        return [];
      }
      const store = await StateStore.open(root);
      const runs = await store.listRuns();
      return await Promise.all(runs.map(async (state) => await summarize(store, state)));
    }
    const entries = await this.registry.list();
    const seen = new Set<string>();
    const summaries: RunSummary[] = [];
    for (const entry of entries) {
      if (seen.has(entry.run_id)) continue;
      seen.add(entry.run_id);
      try {
        const store = await StateStore.open(entry.repo_root);
        const state = await store.readRun(entry.run_id);
        if (state !== undefined) summaries.push(await summarize(store, state));
      } catch {
        // A repository can move or disappear; other runs remain listable.
      }
    }
    return summaries.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async getStatus(runId: string, repoRoot?: string): Promise<RunSummary> {
    const root = await this.resolveRepoRoot(runId, repoRoot);
    const store = await StateStore.open(root);
    const state = await store.readRun(runId);
    if (state === undefined) throw new Error(`run not found: ${runId}`);
    return await summarize(store, state);
  }

  async getRun(
    runId: string,
    repoRoot?: string,
    options: { includeFiles?: boolean; includeArtifacts?: boolean } = {},
  ): Promise<RunDetail> {
    const includeFiles = options.includeFiles !== false;
    const includeArtifacts = options.includeArtifacts !== false;
    const root = await this.resolveRepoRoot(runId, repoRoot);
    const store = await StateStore.open(root);
    const state = await store.readRun(runId);
    if (state === undefined) throw new Error(`run not found: ${runId}`);
    const summary = await summarize(store, state);
    const runDirectory = store.getRunDirectory(runId);
    const [events, evidence, artifacts, spec] = await Promise.all([
      store.readEvents(runId, EVENT_LIMIT),
      new EvidenceLedger(root).readAll(runId),
      includeArtifacts ? listArtifacts(runDirectory) : Promise.resolve([]),
      readFile(join(runDirectory, 'spec.md'), 'utf8').catch(() => ''),
    ]);
    const worktree = state.integration_worktree ?? null;
    const changed = includeFiles && worktree !== null ? await gitChangedFiles(worktree, state.baseline_commit) : [];
    return {
      ...summary,
      spec_excerpt: spec.slice(0, 6_000),
      config: state.config,
      tasks: state.graph.tasks.map((task) => ({
        id: task.id,
        type: task.type,
        title: task.title,
        status: task.status,
        priority: task.priority,
        risk: task.risk,
        origin: task.origin,
        worker_role: task.worker_role,
        attempt: task.attempt,
        max_attempts: task.max_attempts,
        depends_on: task.depends_on,
        scope_paths: task.scope_paths,
        requirement_ids: task.requirement_ids,
        acceptance_ids: task.acceptance_ids,
        verification_commands: task.verification_commands,
        changed_files: task.changed_files ?? [],
        last_summary: task.last_summary ?? null,
        failure_context: task.failure_context ?? null,
        workspace_path: task.workspace_path ?? null,
        code_snapshot_id: task.code_snapshot_id ?? null,
        repairs_task_id: task.repairs_task_id ?? null,
      })),
      requirements: state.graph.requirements ?? [],
      acceptance: state.graph.acceptance ?? [],
      decisions: timeline(events, state),
      events: events.map((event) => ({
        id: String(event.event_id ?? ''),
        timestamp: String(event.timestamp ?? ''),
        type: String(event.type ?? 'unknown'),
        task_id: typeof event.task_id === 'string' ? event.task_id : null,
        message: eventMessage(event),
      })),
      evidence,
      files: {
        worktree,
        baseline_commit: state.baseline_commit ?? null,
        changed,
        tasks: state.graph.tasks.map((task) => ({
          task_id: task.id,
          title: task.title,
          status: task.status,
          paths: task.changed_files ?? [],
          workspace_path: task.workspace_path ?? null,
        })),
      },
      artifacts,
      decision_blockers: state.decision_blockers ?? [],
    };
  }

  async readFile(
    runId: string,
    path: string,
    source: 'worktree' | 'repo' | 'artifact',
    repoRoot?: string,
    taskId?: string,
  ): Promise<FilePreview> {
    const root = await this.resolveRepoRoot(runId, repoRoot);
    const store = await StateStore.open(root);
    const state = await store.readRun(runId);
    if (state === undefined) throw new Error(`run not found: ${runId}`);
    if (source === 'artifact') {
      const preview = await readBoundedFile(store.getRunDirectory(runId), path, FILE_READ_LIMIT);
      return { ...preview, source };
    }
    if (source === 'repo') {
      const preview = await readBoundedFile(state.repo_root, path, FILE_READ_LIMIT);
      return { ...preview, source };
    }
    for (const worktree of this.worktreeCandidates(state, taskId)) {
      try {
        const preview = await readBoundedFile(worktree, path, FILE_READ_LIMIT);
        return { ...preview, source };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new Error(`file not found in this run's worktrees: ${path}`);
  }

  async readDiff(
    runId: string,
    path: string,
    repoRoot?: string,
    taskId?: string,
  ): Promise<string> {
    const root = await this.resolveRepoRoot(runId, repoRoot);
    const store = await StateStore.open(root);
    const state = await store.readRun(runId);
    if (state === undefined) throw new Error(`run not found: ${runId}`);
    assertSafeRelativePath(path);
    for (const worktree of this.worktreeCandidates(state, taskId)) {
      const diff = await diffInWorktree(worktree, path, state.baseline_commit);
      if (diff.length > 0) return diff;
    }
    return '';
  }

  private worktreeCandidates(state: RunState, taskId?: string): string[] {
    const candidates: string[] = [];
    if (taskId !== undefined) {
      const task = state.graph.tasks.find((candidate) => candidate.id === taskId);
      if (task?.workspace_path !== undefined) candidates.push(task.workspace_path);
    }
    if (state.integration_worktree !== undefined) candidates.push(state.integration_worktree);
    for (const task of state.graph.tasks) {
      if (task.workspace_path !== undefined && !candidates.includes(task.workspace_path)) {
        candidates.push(task.workspace_path);
      }
    }
    return candidates;
  }
}

async function diffInWorktree(worktree: string, path: string, baseline: string | undefined): Promise<string> {
  const exec = createNodeGitExecutor();
  if (baseline !== undefined) {
    const result = await exec(['diff', '--no-color', '--unified=3', baseline, '--', path], worktree);
    if (result.exitCode === 0 && result.stdout.length > 0) return result.stdout.slice(0, FILE_READ_LIMIT);
  }
  const result = await exec(['diff', '--no-color', '--unified=3', '--', path], worktree);
  if (result.exitCode === 0 && result.stdout.length > 0) return result.stdout.slice(0, FILE_READ_LIMIT);
  // An untracked file has no Git diff; present its content as an added file.
  const status = await exec(['status', '--porcelain', '--', path], worktree);
  if (status.stdout.trimStart().startsWith('??')) {
    try {
      const preview = await readBoundedFile(worktree, path, FILE_READ_LIMIT);
      const lines = preview.content.split('\n');
      return [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
      ].join('\n');
    } catch {
      return '';
    }
  }
  return '';
}
