import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryToolService } from '../../src/mcp/tools.js';
import { StateStore } from '../../src/state/state-store.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState } from '../../src/domain/types.js';
import { EvidenceLedger } from '../../src/state/evidence-ledger.js';

async function managedRun(): Promise<{
  service: DeliveryToolService;
  store: StateStore;
  state: RunState;
}> {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-mcp-'));
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
  for (let index = 0; index < 15; index += 1) {
    await store.appendEvent('run-1', { type: 'tick', index });
  }
  const manager = {
    async get() {
      return {
        state,
        store,
        repoRoot: repo,
        controller: {
          async pause() { return state; },
          async resume() { return state; },
          async cancel() { return state; },
          async respond() { return state; },
        },
      };
    },
    async start() { return this.get(); },
  };
  const service = new DeliveryToolService(manager as never, async () => {});
  return { service, store, state };
}

test('status returns a bounded summary rather than full logs', async () => {
  const { service, store } = await managedRun();
  await store.updateRun('run-1', (state) => ({
    ...state,
    usage_incomplete: true,
  }));

  const response = await service.delivery_status({ run_id: 'run-1' });

  assert.equal(response.run_id, 'run-1');
  assert.equal(response.revision, 1);
  assert.equal(response.total_tokens_used, 0);
  assert.equal(response.usage_incomplete, true);
  assert.equal(response.recent_events.length, 10);
  assert.equal('events' in response, false);
  assert.equal('graph' in response, false);
});

test('status uses the read-only manager path when available', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-mcp-read-'));
  const store = await StateStore.open(repo);
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-read',
    status: 'BLOCKED',
    repo_root: repo,
    created_at: '2026-11-03T00:00:00Z',
    updated_at: '2026-11-03T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-read', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
    last_error: 'worker failed before runtime construction',
  };
  await store.createRun(state);
  let reads = 0;
  const service = new DeliveryToolService(
    {
      async read() {
        reads += 1;
        return { state, store, repoRoot: repo };
      },
      async get() {
        throw new Error('status must not resolve a mutable runtime');
      },
      async start() {
        throw new Error('not used');
      },
    } as never,
    async () => {},
  );

  const response = await service.delivery_status({ run_id: 'run-read' });

  assert.equal(reads, 1);
  assert.equal(response.status, 'BLOCKED');
  assert.equal(response.last_error, 'worker failed before runtime construction');
});

test('export report uses the resolved repository and includes persisted evidence', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-mcp-report-'));
  const unrelated = await mkdtemp(join(tmpdir(), 'delivery-loop-mcp-unrelated-'));
  const store = await StateStore.open(repo);
  const state: RunState = {
    state_schema_version: 1,
    run_id: 'run-report',
    status: 'COMPLETED',
    repo_root: repo,
    created_at: '2026-11-03T00:00:00Z',
    updated_at: '2026-11-03T00:00:00Z',
    config: structuredClone(DEFAULT_CONFIG),
    graph: { run_id: 'run-report', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
  await store.createRun(state);
  await new EvidenceLedger(repo).append({
    id: 'E-1',
    run_id: state.run_id,
    task_id: 'VERIFY',
    acceptance_ids: [],
    code_snapshot_id: 'snapshot-1',
    command: 'npm test',
    cwd: repo,
    started_at: state.created_at,
    finished_at: state.updated_at,
    exit_code: 0,
    stdout_path: '',
    stderr_path: '',
    result: 'passed',
  });
  const service = new DeliveryToolService(
    {
      async read() { return { state, store, repoRoot: repo }; },
      async get() { throw new Error('report export must use the read path'); },
      async start() { throw new Error('not used'); },
    } as never,
    async () => {},
  );

  const result = await service.delivery_export_report({
    run_id: state.run_id,
    repo_root: unrelated,
  });

  assert.match(result.report_path, new RegExp(`^${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(await readFile(result.report_path, 'utf8'), /npm test/);
});

test('finalize requires exact run id confirmation', async () => {
  const { service } = await managedRun();

  await assert.rejects(
    service.delivery_finalize({ run_id: 'run-1', mode: 'commit', confirmation: 'yes' }),
    /confirm/i,
  );
});

test('prepare-only finalize succeeds without executing commit', async () => {
  const { service, state } = await managedRun();
  const calls: string[] = [];
  const serviceWithSpy = new DeliveryToolService(
    {
      async get() {
        return { state, store: await StateStore.open(state.repo_root), repoRoot: state.repo_root, controller: {} as never };
      },
      async start() { throw new Error('not used'); },
    } as never,
    async (action) => {
      calls.push(action);
    },
  );

  const result = await serviceWithSpy.delivery_finalize({
    run_id: 'run-1',
    mode: 'prepare-only',
    confirmation: 'run-1',
  });

  assert.equal(result.status, 'prepare-only');
  assert.deepEqual(calls, []);
});
