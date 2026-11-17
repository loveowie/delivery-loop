import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import type { RunState } from '../domain/types.js';
import type { StateStore } from '../state/state-store.js';

export type FinalizeMode = 'prepare-only' | 'commit' | 'branch' | 'push' | 'merge';

export interface FinalizeInput {
  mode: FinalizeMode;
  confirmation: string;
}

export interface FinalizeResult {
  run_id: string;
  status: FinalizeMode;
}

export type FinalizeAction = Exclude<FinalizeMode, 'prepare-only'>;
export type FinalizeRecordValue = string | number | boolean | null;
export type FinalizeRecord = Record<string, FinalizeRecordValue>;

export interface FinalizationJournal {
  version: 1;
  run_id: string;
  action: FinalizeAction;
  status: 'intent' | 'completed';
  integration_snapshot_id: string | null;
  completion_sha256: string | null;
  started_at: string;
  metadata?: FinalizeRecord;
  completed_at?: string;
  result?: FinalizeRecord;
}

export interface FinalizeExecutionContext {
  reconcile: boolean;
  journal: FinalizationJournal;
  recordIntentMetadata(metadata: FinalizeRecord): Promise<void>;
}

export type FinalizeExecutionResult = FinalizeRecord | void;
export type FinalizeExecute = (
  action: FinalizeAction,
  state: RunState,
  context: FinalizeExecutionContext,
) => Promise<FinalizeExecutionResult>;

function journalPath(store: StateStore, runId: string): string {
  return join(store.getRunDirectory(runId), 'finalization', 'journal.json');
}

async function readJournal(
  store: StateStore,
  runId: string,
): Promise<FinalizationJournal | undefined> {
  try {
    return JSON.parse(await readFile(journalPath(store, runId), 'utf8')) as FinalizationJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeJournal(store: StateStore, journal: FinalizationJournal): Promise<void> {
  const temporaryRelativePath = `finalization/.journal.${randomUUID()}.tmp`;
  const temporaryPath = await store.writeArtifact(
    journal.run_id,
    temporaryRelativePath,
    `${JSON.stringify(journal, null, 2)}\n`,
  );
  await rename(temporaryPath, journalPath(store, journal.run_id));
}

async function validateCompletionReference(store: StateStore, state: RunState): Promise<void> {
  if (state.completion_ref === undefined) {
    return;
  }
  const runDirectory = resolve(store.getRunDirectory(state.run_id));
  const referencedPath = resolve(
    isAbsolute(state.completion_ref.path)
      ? state.completion_ref.path
      : join(runDirectory, state.completion_ref.path),
  );
  const pathWithinRun = relative(runDirectory, referencedPath);
  if (pathWithinRun.startsWith('..') || isAbsolute(pathWithinRun)) {
    throw new Error('completion certificate path escapes the run directory');
  }
  let content: string;
  try {
    content = await readFile(referencedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`completion certificate is missing: ${referencedPath}`);
    }
    throw error;
  }
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== state.completion_ref.sha256) {
    throw new Error('completion certificate digest mismatch');
  }
  let certificate: { snapshot_id?: unknown };
  try {
    certificate = JSON.parse(content) as { snapshot_id?: unknown };
  } catch {
    throw new Error('completion certificate is not valid JSON');
  }
  if (
    state.integration_snapshot_id !== undefined &&
    certificate.snapshot_id !== state.integration_snapshot_id
  ) {
    throw new Error('completion certificate snapshot does not match the accepted integration');
  }
}

function assertJournalMatches(
  journal: FinalizationJournal,
  action: FinalizeAction,
  state: RunState,
): void {
  if (journal.run_id !== state.run_id) {
    throw new Error(`finalization journal belongs to a different run: ${journal.run_id}`);
  }
  if (journal.action !== action) {
    throw new Error(`finalization already targets ${journal.action}; requested ${action}`);
  }
  if (journal.integration_snapshot_id !== (state.integration_snapshot_id ?? null)) {
    throw new Error('finalization journal targets a different integration snapshot');
  }
  if (journal.completion_sha256 !== (state.completion_ref?.sha256 ?? null)) {
    throw new Error('finalization journal targets a different completion certificate');
  }
}

export async function finalizeRun(
  store: StateStore,
  runId: string,
  input: FinalizeInput,
  execute: FinalizeExecute,
  verifySnapshot?: (state: RunState) => Promise<void>,
): Promise<FinalizeResult> {
  const allowedModes: FinalizeMode[] = ['prepare-only', 'commit', 'branch', 'push', 'merge'];
  if (!allowedModes.includes(input.mode)) {
    throw new Error(`unknown finalization mode: ${String(input.mode)}`);
  }
  if (input.mode === 'merge') {
    throw new Error('merge finalization requires a project-specific finalizer');
  }
  if (input.confirmation !== `${runId}:${input.mode}`) {
    throw new Error('finalize confirmation must exactly match "<run id>:<mode>"');
  }
  const initialState = await store.readRun(runId);
  if (initialState === undefined) {
    throw new Error(`run not found: ${runId}`);
  }
  if (initialState.status !== 'COMPLETED') {
    throw new Error(`run ${runId} is not completed`);
  }
  if (input.mode === 'prepare-only') {
    return { run_id: runId, status: 'prepare-only' };
  }

  const directory = join(store.getRunDirectory(runId), 'finalization');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    realpath: false,
    lockfilePath: join(directory, 'finalize.lock'),
    stale: 30_000,
    update: 10_000,
    retries: { retries: 400, factor: 1, minTimeout: 10, maxTimeout: 25 },
  });
  try {
    const state = await store.readRun(runId);
    if (state === undefined) {
      throw new Error(`run not found: ${runId}`);
    }
    if (state.status !== 'COMPLETED') {
      throw new Error(`run ${runId} is not completed`);
    }
    await validateCompletionReference(store, state);
    let journal = await readJournal(store, runId);
    const reconcile = journal !== undefined;
    if (journal !== undefined) {
      assertJournalMatches(journal, input.mode, state);
      if (journal.status === 'completed') {
        return { run_id: runId, status: input.mode };
      }
    } else {
      journal = {
        version: 1,
        run_id: runId,
        action: input.mode,
        status: 'intent',
        integration_snapshot_id: state.integration_snapshot_id ?? null,
        completion_sha256: state.completion_ref?.sha256 ?? null,
        started_at: new Date().toISOString(),
      };
      await writeJournal(store, journal);
    }

    const activeJournal = journal;
    await verifySnapshot?.(state);
    const context: FinalizeExecutionContext = {
      reconcile,
      journal: activeJournal,
      async recordIntentMetadata(metadata) {
        const nextJournal: FinalizationJournal = {
          ...context.journal,
          metadata: { ...(context.journal.metadata ?? {}), ...metadata },
        };
        context.journal = nextJournal;
        await writeJournal(store, nextJournal);
      },
    };
    const result = await execute(input.mode, state, context);
    const completedJournal: FinalizationJournal = {
      ...context.journal,
      status: 'completed',
      completed_at: new Date().toISOString(),
      result: result ?? {},
    };
    await writeJournal(store, completedJournal);
    await store.appendEvent(runId, {
      type: 'run_finalized',
      mode: input.mode,
      result: completedJournal.result,
    });
    return { run_id: runId, status: input.mode };
  } finally {
    await release();
  }
}
