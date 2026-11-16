import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexExecAdapter } from '../../src/workers/codex-exec-adapter.js';
import type { AgentRequest } from '../../src/domain/types.js';

const fixtureCommand = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'codex-process-fixture.mjs',
);

function request(workdir: string, objective: string, timeoutSeconds = 5): AgentRequest {
  return {
    run_id: 'run-1',
    task_id: 'TASK-1',
    role: 'implementer',
    capability_profile: 'portable',
    required_skills: [],
    objective,
    workdir,
    requirement_ids: [],
    acceptance_ids: [],
    scope_paths: [],
    constraints: [],
    verification_commands: [],
    context_files: [],
    timeout_seconds: timeoutSeconds,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path)).length > 0) return;
    } catch {
      // The fixture has not created the marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test('abort waits for TERM-resistant process group termination', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const started = join(workdir, 'started.json');
  const controller = new AbortController();
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
    terminationGraceMs: 50,
  });

  try {
    const running = adapter.run(
      request(workdir, `mode=ignore-term started=${started}`),
      { signal: controller.signal },
    );
    await waitForFile(started);
    const pids = JSON.parse(await readFile(started, 'utf8')) as { parent: number; child: number };
    controller.abort();
    const result = await running;

    assert.equal(result.status, 'failed');
    assert.equal(result.token_usage, 555);
    assert.equal(processAlive(pids.parent), false);
    assert.equal(processAlive(pids.child), false);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('a pre-aborted signal prevents the worker process from spawning', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const spawned = join(workdir, 'spawned.txt');
  const controller = new AbortController();
  controller.abort();
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
    terminationGraceMs: 20,
  });

  try {
    const result = await adapter.run(
      request(workdir, `mode=pre-aborted spawned=${spawned}`),
      { signal: controller.signal },
    );

    assert.equal(result.status, 'failed');
    assert.match(result.summary, /abort|cancel/i);
    assert.equal(await exists(spawned), false);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('non-zero exits preserve measured JSONL token usage', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
  });

  try {
    const result = await adapter.run(request(workdir, 'mode=failed-with-usage'));
    assert.equal(result.status, 'failed');
    assert.equal(result.token_usage, 321);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('timeout waits for process termination and preserves final measured usage', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const started = join(workdir, 'started.json');
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
    terminationGraceMs: 50,
  });

  try {
    const running = adapter.run(request(workdir, `mode=timeout started=${started}`, 1));
    await waitForFile(started);
    const { parent } = JSON.parse(await readFile(started, 'utf8')) as { parent: number };
    const result = await running;

    assert.equal(result.status, 'failed');
    assert.match(result.summary, /timed_out/);
    assert.equal(result.token_usage, 654);
    assert.equal(processAlive(parent), false);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('normal worker exit cleans up a lingering descendant before succeeding', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const started = join(workdir, 'started.json');
  let childPid: number | undefined;
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
    terminationGraceMs: 50,
  });

  try {
    const result = await adapter.run(request(workdir, `mode=normal-with-descendant started=${started}`));
    const pids = JSON.parse(await readFile(started, 'utf8')) as { child: number };
    childPid = pids.child;

    assert.equal(result.status, 'completed');
    assert.equal(result.token_usage, 777);
    assert.equal(processAlive(childPid), false);
  } finally {
    if (childPid !== undefined && processAlive(childPid)) process.kill(childPid, 'SIGKILL');
    await rm(workdir, { recursive: true, force: true });
  }
});

test('spawn errors return a failed result without hanging', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: join(workdir, 'missing-command'),
    terminationGraceMs: 20,
  });

  try {
    const result = await adapter.run(request(workdir, 'mode=unused'));
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /ENOENT/);
    assert.equal(result.token_usage, undefined);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('unmeasured model self-report is discarded instead of treated as zero', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
  });

  try {
    const result = await adapter.run(request(workdir, 'mode=unmeasured-self-report'));
    assert.equal(result.status, 'completed');
    assert.equal(result.token_usage, undefined);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('failed invocations omit usage when no valid event was measured', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
  });

  try {
    const result = await adapter.run(request(workdir, 'mode=failed-unmeasured'));
    assert.equal(result.status, 'failed');
    assert.equal(result.token_usage, undefined);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('measured JSONL usage overrides worker-reported token usage after output flush', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
  });

  try {
    const result = await adapter.run(request(workdir, 'mode=large-output'));
    assert.equal(result.status, 'completed');
    assert.equal(result.token_usage, 175);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('a measured zero usage overrides worker-reported token usage', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
  });

  try {
    const result = await adapter.run(request(workdir, 'mode=measured-zero'));
    assert.equal(result.status, 'completed');
    assert.equal(result.token_usage, 0);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('worker results with a different task id are rejected', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
  });

  try {
    const result = await adapter.run(request(workdir, 'mode=mismatched-task'));
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /task.*mismatch/i);
    assert.equal(result.token_usage, 222);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('result parse failures preserve measured JSONL token usage', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
  });

  try {
    const result = await adapter.run(request(workdir, 'mode=malformed-result'));
    assert.equal(result.status, 'failed');
    assert.equal(result.token_usage, 200);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('optional diagnostics retain sanitized logs and result', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'delivery-loop-process-test-'));
  const diagnostics = join(workdir, 'diagnostics');
  const adapter = new CodexExecAdapter({
    schemaPath: join(workdir, 'schema.json'),
    command: fixtureCommand,
    diagnosticDirectory: diagnostics,
  });

  try {
    const result = await adapter.run(request(workdir, 'mode=diagnostics'));
    assert.equal(result.status, 'completed');
    const [invocationDirectory] = await readdir(diagnostics);
    assert.ok(invocationDirectory);
    const retainedDirectory = join(diagnostics, invocationDirectory);
    const stderr = await readFile(join(retainedDirectory, 'stderr.log'), 'utf8');
    const retainedResult = await readFile(join(retainedDirectory, 'result.json'), 'utf8');
    assert.doesNotMatch(stderr, /fixture-secret/);
    assert.doesNotMatch(retainedResult, /fixture-secret/);
    assert.match(stderr, /REDACTED/);
    assert.match(retainedResult, /REDACTED/);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});
