import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchIntegrator } from '../../src/workspace/patch-integrator.js';

test('patch export uses a temporary index for intent-to-add', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-patch-'));
  const output = await mkdtemp(join(tmpdir(), 'delivery-loop-output-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'new.ts'), 'export const value = 1;\n');
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const executor = {
    async exec(
      args: string[],
      _cwd?: string,
      _approval?: { run_id: string },
      options?: { env?: NodeJS.ProcessEnv },
    ) {
      calls.push({ args, ...(options?.env === undefined ? {} : { env: options.env }) });
      if (args[0] === 'rev-parse') {
        return { stdout: '.git/index', stderr: '', exitCode: 0 };
      }
      return { stdout: 'diff --binary --git a/a b/a\n', stderr: '', exitCode: 0 };
    },
  };
  const integrator = new PatchIntegrator(executor);

  const artifact = await integrator.exportTaskPatch(root, 'abc123', output, ['src/new.ts']);

  assert.deepEqual(calls.map((call) => call.args), [
    ['read-tree', 'abc123'],
    ['rev-parse', '--git-path', 'index'],
    ['ls-files', '-z'],
    ['ls-files', '-z'],
    ['add', '-N', '--', 'src/new.ts'],
    ['diff', '--binary', '--no-ext-diff', 'abc123'],
  ]);
  const temporaryIndex = calls[0]?.env?.GIT_INDEX_FILE;
  assert.ok(temporaryIndex);
  assert.equal(calls[2]?.env?.GIT_INDEX_FILE, temporaryIndex);
  assert.notEqual(calls[3]?.env?.GIT_INDEX_FILE, temporaryIndex);
  assert.equal(calls[4]?.env?.GIT_INDEX_FILE, temporaryIndex);
  assert.equal(calls[5]?.env?.GIT_INDEX_FILE, temporaryIndex);
  const content = await readFile(artifact.path, 'utf8');
  assert.match(content, /diff --binary/);
});

test('patch application uses git apply against the integration worktree', async () => {
  const patchDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-apply-'));
  const patchPath = join(patchDirectory, 'delivery.patch');
  await writeFile(patchPath, 'diff --git a/a b/a\n');
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const executor = {
    async exec(args: string[], cwd?: string) {
      calls.push({ args, ...(cwd === undefined ? {} : { cwd }) });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const integrator = new PatchIntegrator(executor);

  const result = await integrator.applyToIntegration('/tmp/integration', patchPath, {
    run_id: 'run-1',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0]?.args, ['apply', '--whitespace=nowarn', patchPath]);
  assert.equal(calls[0]?.cwd, '/tmp/integration');
});
