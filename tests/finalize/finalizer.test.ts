import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeRun } from '../../src/finalize/finalizer.js';
import { StateStore } from '../../src/state/state-store.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState } from '../../src/domain/types.js';

async function completedState(repo: string): Promise<{ store: StateStore; state: RunState }> {
  const store = await StateStore.open(repo);
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-1',
    status: 'COMPLETED',
    repo_root: repo,
    created_at: '2026-10-28T00:00:00Z',
    updated_at: '2026-10-28T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-1', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
  await store.createRun(state);
  return { store, state };
}

test('prepare-only completion never invokes commit or push', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-finalize-'));
  const { store } = await completedState(repo);
  const calls: string[] = [];

  const result = await finalizeRun(store, 'run-1', {
    mode: 'prepare-only',
    confirmation: 'run-1:prepare-only',
  }, async (action) => {
    calls.push(action);
  });

  assert.equal(result.status, 'prepare-only');
  assert.deepEqual(calls, []);
});

test('finalize requires exact run id confirmation', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-finalize-'));
  const { store } = await completedState(repo);

  await assert.rejects(
    finalizeRun(store, 'run-1', { mode: 'commit', confirmation: 'yes' }, async () => {}),
    /confirm/i,
  );
});

test('non-prepare finalization rejects a changed integration snapshot', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-finalize-'));
  const { store } = await completedState(repo);

  await assert.rejects(
    finalizeRun(
      store,
      'run-1',
      { mode: 'commit', confirmation: 'run-1:commit' },
      async () => {},
      async () => {
        throw new Error('snapshot mismatch');
      },
    ),
    /snapshot mismatch/i,
  );
});

test('completed finalization is idempotent and does not execute twice', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-finalize-'));
  const { store } = await completedState(repo);
  let executions = 0;

  const first = await finalizeRun(
    store,
    'run-1',
    { mode: 'commit', confirmation: 'run-1:commit' },
    async () => {
      executions += 1;
      return { head: 'abc123' };
    },
  );
  const second = await finalizeRun(
    store,
    'run-1',
    { mode: 'commit', confirmation: 'run-1:commit' },
    async () => {
      executions += 1;
      return { head: 'unexpected' };
    },
  );

  assert.equal(executions, 1);
  assert.equal(first.status, 'commit');
  assert.equal(second.status, 'commit');
});

test('concurrent finalization requests serialize and execute once', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-finalize-'));
  const { store } = await completedState(repo);
  let executions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const execute = async () => {
    executions += 1;
    await gate;
    return { head: 'abc123' };
  };

  const first = finalizeRun(store, 'run-1', { mode: 'commit', confirmation: 'run-1:commit' }, execute);
  const second = finalizeRun(store, 'run-1', { mode: 'commit', confirmation: 'run-1:commit' }, execute);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all([first, second]);

  assert.equal(executions, 1);
});

test('unfinished intent is retried in reconciliation mode', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-finalize-'));
  const { store } = await completedState(repo);
  let reconcile = false;

  await assert.rejects(
    finalizeRun(
      store,
      'run-1',
      { mode: 'commit', confirmation: 'run-1:commit' },
      async (_action, _state, context) => {
        await context.recordIntentMetadata({ starting_head: 'abc123' });
        throw new Error('simulated crash after intent');
      },
    ),
    /simulated crash/,
  );
  await finalizeRun(
    store,
    'run-1',
    { mode: 'commit', confirmation: 'run-1:commit' },
    async (_action, _state, context) => {
      reconcile = context.reconcile;
      assert.equal(context.journal.metadata?.starting_head, 'abc123');
      return { head: 'def456' };
    },
  );

  assert.equal(reconcile, true);
});

test('conflicting action is rejected after a finalization intent exists', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-finalize-'));
  const { store } = await completedState(repo);
  await assert.rejects(
    finalizeRun(
      store,
      'run-1',
      { mode: 'commit', confirmation: 'run-1:commit' },
      async () => { throw new Error('leave intent'); },
    ),
    /leave intent/,
  );

  await assert.rejects(
    finalizeRun(store, 'run-1', { mode: 'branch', confirmation: 'run-1:branch' }, async () => {}),
    /already targets commit/i,
  );
});

test('non-prepare finalization validates the completion certificate digest', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-finalize-'));
  const { store } = await completedState(repo);
  const path = join(store.getRunDirectory('run-1'), 'completion.json');
  const certificate = JSON.stringify({ run_id: 'run-1', snapshot_id: 'snapshot-1' });
  await writeFile(path, certificate);
  await store.updateRun('run-1', (state) => ({
    ...state,
    integration_snapshot_id: 'snapshot-1',
    completion_ref: { path, sha256: createHash('sha256').update('different').digest('hex') },
  }));
  let executed = false;

  await assert.rejects(
    finalizeRun(
      store,
      'run-1',
      { mode: 'commit', confirmation: 'run-1:commit' },
      async () => { executed = true; },
    ),
    /completion certificate digest mismatch/i,
  );

  assert.equal(executed, false);
});

test('a rejected merge does not poison the finalization journal for later modes', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-finalize-'));
  const { store } = await completedState(repo);
  await assert.rejects(
    finalizeRun(store, 'run-1', { mode: 'merge', confirmation: 'run-1:merge' }, async () => {}),
    /merge finalization/i,
  );
  const result = await finalizeRun(
    store,
    'run-1',
    { mode: 'prepare-only', confirmation: 'run-1:prepare-only' },
    async () => {},
  );
  assert.equal(result.status, 'prepare-only');
});
