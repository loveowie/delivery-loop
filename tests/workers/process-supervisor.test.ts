import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSupervisedProcess } from '../../src/runtime/process-supervisor.js';

test('supervised processes use the requested cwd and exact environment', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-supervisor-test-'));
  const stdoutPath = join(workdir, 'stdout.log');
  const stderrPath = join(workdir, 'stderr.log');

  try {
    const result = await runSupervisedProcess({
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.FIXTURE_VALUE,leaked:process.env.PATH}))",
      ],
      cwd: workdir,
      env: { FIXTURE_VALUE: 'isolated' },
      timeoutMs: 2_000,
      terminationGraceMs: 20,
      stdoutPath,
      stderrPath,
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(stdoutPath, 'utf8')), {
      cwd: await realpath(workdir),
      value: 'isolated',
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});
