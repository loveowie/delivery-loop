import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchIntegrator } from '../../src/workspace/patch-integrator.js';
import { createGitFixture, fixtureExecutor } from './git-fixture.js';

test('full patch round-trips tracked and binary untracked content without changing the real index', async () => {
  const source = await createGitFixture();
  const target = await createGitFixture();
  const output = await mkdtemp(join(tmpdir(), 'delivery-loop-patch-output-'));
  try {
    await source.write('src/tracked.txt', 'changed\n');
    await source.write('src/new.bin', Buffer.from([0, 255, 10, 128]));
    await source.git(['add', '--', 'src/tracked.txt']);
    const indexBefore = (await source.git(['diff', '--cached', '--binary'])).stdout;
    const integrator = new PatchIntegrator(fixtureExecutor(source));

    const patch = await integrator.exportTaskPatch(
      source.path,
      source.baseline,
      output,
      ['src/new.bin'],
      { run_id: 'run-1' },
    );

    assert.equal((await source.git(['diff', '--cached', '--binary'])).stdout, indexBefore);
    const applier = new PatchIntegrator(fixtureExecutor(target));
    assert.deepEqual(
      await applier.applyToIntegration(target.path, patch.path, { run_id: 'run-1' }),
      { ok: true },
    );
    assert.equal(await readFile(join(target.path, 'src', 'tracked.txt'), 'utf8'), 'changed\n');
    assert.deepEqual(
      await readFile(join(target.path, 'src', 'new.bin')),
      Buffer.from([0, 255, 10, 128]),
    );
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('full patch keeps an earlier staged addition when a later task changes another file', async () => {
  const source = await createGitFixture();
  const target = await createGitFixture();
  const output = await mkdtemp(join(tmpdir(), 'delivery-loop-combined-patch-output-'));
  try {
    await source.write('src/earlier.txt', 'earlier accepted content\n');
    await source.git(['add', '--', 'src/earlier.txt']);
    await source.write('src/tracked.txt', 'later task content\n');
    const integrator = new PatchIntegrator(fixtureExecutor(source));

    const patch = await integrator.exportTaskPatch(
      source.path,
      source.baseline,
      output,
      [],
      { run_id: 'run-1' },
    );

    const applier = new PatchIntegrator(fixtureExecutor(target));
    assert.deepEqual(
      await applier.applyToIntegration(target.path, patch.path, { run_id: 'run-1' }),
      { ok: true },
    );
    assert.equal(
      await readFile(join(target.path, 'src', 'earlier.txt'), 'utf8'),
      'earlier accepted content\n',
    );
    assert.equal(
      await readFile(join(target.path, 'src', 'tracked.txt'), 'utf8'),
      'later task content\n',
    );
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('delta patch compares against the staged seed while preserving that seed index', async () => {
  const source = await createGitFixture();
  const target = await createGitFixture();
  const output = await mkdtemp(join(tmpdir(), 'delivery-loop-delta-output-'));
  try {
    await source.write('src/tracked.txt', 'seeded\n');
    await source.git(['add', '-A']);
    await target.write('src/tracked.txt', 'seeded\n');
    await source.write('src/new.bin', Buffer.from([0, 1, 2, 255]));
    const indexBefore = (await source.git(['diff', '--cached', '--binary'])).stdout;
    const integrator = new PatchIntegrator(fixtureExecutor(source));

    const patch = await integrator.exportDeltaPatch(
      source.path,
      output,
      ['src/new.bin'],
      { run_id: 'run-1' },
    );

    assert.equal((await source.git(['diff', '--cached', '--binary'])).stdout, indexBefore);
    const applier = new PatchIntegrator(fixtureExecutor(target));
    assert.deepEqual(
      await applier.applyToIntegration(target.path, patch.path, { run_id: 'run-1' }),
      { ok: true },
    );
    assert.equal(await readFile(join(target.path, 'src', 'tracked.txt'), 'utf8'), 'seeded\n');
    assert.deepEqual(await readFile(join(target.path, 'src', 'new.bin')), Buffer.from([0, 1, 2, 255]));
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('managed delta export rejects a missing frozen seed index', async () => {
  const source = await createGitFixture();
  const output = await mkdtemp(join(tmpdir(), 'delivery-loop-missing-seed-index-'));
  try {
    await source.write('src/tracked.txt', 'worker content\n');
    await source.git(['add', '--', 'src/tracked.txt']);
    const integrator = new PatchIntegrator(fixtureExecutor(source));

    await assert.rejects(
      integrator.exportDeltaPatch(
        source.path,
        output,
        [],
        { run_id: 'run-1' },
        { requireFrozenBase: true },
      ),
      /frozen delta base is missing/i,
    );
  } finally {
    await source.cleanup();
  }
});

test('empty patch application succeeds without invoking git apply', async () => {
  const output = await mkdtemp(join(tmpdir(), 'delivery-loop-empty-patch-'));
  await mkdir(output, { recursive: true });
  const patchPath = join(output, 'empty.patch');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(patchPath, ''));
  let calls = 0;
  const integrator = new PatchIntegrator({
    async exec() {
      calls += 1;
      throw new Error('git apply must not be called for an empty patch');
    },
  });

  assert.deepEqual(
    await integrator.applyToIntegration('/tmp/integration', patchPath, { run_id: 'run-1' }),
    { ok: true },
  );
  assert.equal(calls, 0);
});
