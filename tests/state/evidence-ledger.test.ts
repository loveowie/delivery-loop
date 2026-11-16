import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceLedger } from '../../src/state/evidence-ledger.js';
import type { EvidenceRecord } from '../../src/domain/types.js';

const evidence: EvidenceRecord = {
  id: 'E-1',
  run_id: 'run-1',
  task_id: 'TASK-1',
  acceptance_ids: ['AC-1'],
  code_snapshot_id: 'SNAP-1',
  command: 'npm test',
  cwd: '/repo',
  started_at: '2026-10-28T00:00:00Z',
  finished_at: '2026-10-28T00:00:01Z',
  exit_code: 0,
  stdout_path: '/tmp/stdout.log',
  stderr_path: '/tmp/stderr.log',
  result: 'passed',
};

test('evidence ledger persists records across instances', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-evidence-'));
  await new EvidenceLedger(repo).append(evidence);

  const records = await new EvidenceLedger(repo).readAll();

  assert.deepEqual(records, [evidence]);
});

test('evidence ledger replaces a duplicate evidence id idempotently', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-evidence-'));
  const ledger = new EvidenceLedger(repo);
  await ledger.append(evidence);
  await ledger.append({ ...evidence, result: 'failed' });

  const records = await ledger.readAll();

  assert.equal(records.length, 1);
  assert.equal(records[0]?.result, 'failed');
});

test('evidence ledger serializes concurrent appends', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-evidence-'));
  const ledger = new EvidenceLedger(repo);

  await Promise.all(
    Array.from({ length: 10 }, (_value, index) =>
      ledger.append({ ...evidence, id: `E-${index}` }),
    ),
  );

  assert.equal((await ledger.readAll()).length, 10);
});

test('evidence ledger rejects a symlinked evidence directory',async()=>{
  const {mkdir,symlink}=await import('node:fs/promises');const repo=await mkdtemp(join(tmpdir(),'delivery-evidence-safe-'));const outside=await mkdtemp(join(tmpdir(),'delivery-evidence-out-'));await mkdir(join(repo,'.delivery','runs','run-1'),{recursive:true});await symlink(outside,join(repo,'.delivery','runs','run-1','evidence'));
  await assert.rejects(new EvidenceLedger(repo).append(evidence),/symlink/i);
});
