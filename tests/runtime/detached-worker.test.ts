import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDetachedWorker } from '../../src/runtime/detached-worker.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'detached-worker-fixture.mjs',
);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await fileExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test('detached launch resolves only after the matching ready message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-detached-test-'));
  const startedAt = Date.now();
  try {
    await launchDetachedWorker(root, 'run-ready', root, {
      workerPath: fixturePath,
      readyTimeoutMs: 1_000,
      env: {
        ...process.env,
        DELIVERY_FIXTURE_MODE: 'ready',
        DELIVERY_FIXTURE_DELAY_MS: '80',
      },
    });
    assert.ok(Date.now() - startedAt >= 60);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detached launch propagates startup errors and terminates the child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-detached-test-'));
  const pidPath = join(root, 'worker.pid');
  try {
    await assert.rejects(
      launchDetachedWorker(root, 'run-error', root, {
        workerPath: fixturePath,
        readyTimeoutMs: 1_000,
        terminationGraceMs: 20,
        env: {
          ...process.env,
          DELIVERY_FIXTURE_MODE: 'error',
          DELIVERY_FIXTURE_PID_PATH: pidPath,
        },
      }),
      /fixture startup failed/,
    );
    await waitForFile(pidPath);
    assert.equal(processAlive(Number(await readFile(pidPath, 'utf8'))), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detached launch rejects an exit before readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-detached-test-'));
  try {
    await assert.rejects(
      launchDetachedWorker(root, 'run-exit', root, {
        workerPath: fixturePath,
        readyTimeoutMs: 1_000,
        env: { ...process.env, DELIVERY_FIXTURE_MODE: 'exit' },
      }),
      /exited before ready|code 7/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['silent', 'wrong-run'] as const) {
  test(`detached launch times out and kills a ${mode} child`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-detached-test-'));
    const pidPath = join(root, 'worker.pid');
    try {
      await assert.rejects(
        launchDetachedWorker(root, `run-${mode}`, root, {
          workerPath: fixturePath,
          readyTimeoutMs: 500,
          terminationGraceMs: 20,
          env: {
            ...process.env,
            DELIVERY_FIXTURE_MODE: mode,
            DELIVERY_FIXTURE_PID_PATH: pidPath,
          },
        }),
        /ready.*timeout/i,
      );
      await waitForFile(pidPath);
      assert.equal(processAlive(Number(await readFile(pidPath, 'utf8'))), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
