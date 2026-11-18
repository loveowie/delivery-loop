import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { DeliveryConfig, RunState, RunStatus } from '../../src/domain/types.js';
import { StateStore } from '../../src/state/state-store.js';

function runState(
  runId: string,
  status: RunStatus = 'DRAFT',
  createdAt = '2026-11-17T00:00:00.000Z',
): RunState {
  return {
    state_schema_version: 1,
    run_id: runId,
    status,
    repo_root: '/tmp/repo',
    created_at: createdAt,
    updated_at: createdAt,
    config: structuredClone(DEFAULT_CONFIG as DeliveryConfig),
    graph: { run_id: runId, tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
}

async function runDirectoryEntries(repo: string, runId: string): Promise<string[]> {
  return await readdir(join(repo, '.delivery', 'runs', runId));
}

test('listRuns skips a corrupt run.json and still returns every healthy run', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-resilience-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState('healthy-1', 'DRAFT', '2026-11-17T00:00:01.000Z'));
  await store.createRun(runState('healthy-2', 'DRAFT', '2026-11-17T00:00:02.000Z'));
  const broken = join(repo, '.delivery', 'runs', 'broken');
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, 'run.json'), '{"state_schema_version":1,"run_id":');

  const runs = await store.listRuns();

  assert.deepEqual(runs.map((run) => run.run_id), ['healthy-1', 'healthy-2']);
  // Reading a single run stays strict: corruption is isolated, not hidden.
  await assert.rejects(store.readRun('broken'));
});

test('listRuns marks corrupt entries as diagnostics without failing the healthy ones', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-resilience-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState('healthy-1'));
  const unknownSchema = join(repo, '.delivery', 'runs', 'unknown-schema');
  await mkdir(unknownSchema, { recursive: true });
  await writeFile(
    join(unknownSchema, 'run.json'),
    JSON.stringify({ state_schema_version: 99, run_id: 'unknown-schema' }),
  );

  const result = await store.listRunsWithDiagnostics();

  assert.deepEqual(result.runs.map((run) => run.run_id), ['healthy-1']);
  assert.deepEqual(result.corrupt.map((entry) => entry.run_id).sort(), ['unknown-schema']);
  for (const entry of result.corrupt) {
    assert.ok(entry.error.length > 0);
  }
});

test('concurrent createRun for the same run id lets exactly one writer win', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-resilience-'));
  const first = await StateStore.open(repo);
  const second = await StateStore.open(repo);

  const results = await Promise.allSettled([
    first.createRun(runState('run-1')),
    second.createRun(runState('run-1')),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(
    String((rejected[0] as PromiseRejectedResult).reason),
    /already exists/i,
  );

  const content = await readFile(join(repo, '.delivery', 'runs', 'run-1', 'run.json'), 'utf8');
  const parsed = JSON.parse(content) as RunState;
  assert.equal(parsed.run_id, 'run-1');
  assert.equal(parsed.revision, 0);
  const loaded = await first.readRun('run-1');
  assert.equal(loaded?.run_id, 'run-1');
  // No half-written or leftover temporary files in the run directory.
  assert.deepEqual(await runDirectoryEntries(repo, 'run-1'), ['run.json']);
});

test('a failed createRun leaves the existing run.json byte-for-byte intact', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-resilience-'));
  const store = await StateStore.open(repo);
  await store.createRun(runState('run-1'));
  const path = join(repo, '.delivery', 'runs', 'run-1', 'run.json');
  const before = await readFile(path, 'utf8');

  await assert.rejects(store.createRun(runState('run-1')), /already exists/i);

  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await runDirectoryEntries(repo, 'run-1'), ['run.json']);
});

test('createRun publishes only complete JSON under concurrent readers', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-resilience-'));
  const writer = await StateStore.open(repo);
  const reader = await StateStore.open(repo);

  const creation = writer.createRun(runState('run-1'));
  let created = false;
  creation.then(
    () => { created = true; },
    () => { created = true; },
  );
  // A read racing the publish either sees no run at all or a fully valid one.
  const observations: Array<RunState | undefined> = [];
  for (let attempt = 0; !created && attempt < 10_000; attempt += 1) {
    observations.push(await reader.readRun('run-1'));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await creation;

  const loaded = await reader.readRun('run-1');
  assert.equal(loaded?.run_id, 'run-1');
  assert.equal(loaded?.state_schema_version, 1);
  for (const observation of observations) {
    if (observation !== undefined) {
      assert.equal(observation.run_id, 'run-1');
    }
  }
});
