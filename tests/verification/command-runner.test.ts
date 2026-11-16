import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRunner } from '../../src/verification/command-runner.js';

test('command evidence captures a nonzero exit without throwing', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-command-'));
  const runner = new CommandRunner(repo,{execution:{backend:'trusted-host'}});

  const evidence = await runner.run({
    run_id: 'run-1',
    task_id: 'TASK-1',
    acceptance_ids: ['AC-1'],
    code_snapshot_id: 'SNAP-1',
    command: 'node -e "process.exit(2)"',
    cwd: repo,
    timeout_seconds: 10,
  });

  assert.equal(evidence.exit_code, 2);
  assert.equal(evidence.result, 'failed');
  assert.match(evidence.stdout_path, /evidence/);
  assert.match(evidence.stderr_path, /evidence/);
});

test('command evidence redacts secret-shaped values from logs', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-command-'));
  const runner = new CommandRunner(repo,{execution:{backend:'trusted-host'}});

  const evidence = await runner.run({
    run_id: 'run-1',
    task_id: 'TASK-secret',
    acceptance_ids: [],
    code_snapshot_id: 'SNAP-1',
    command: 'node -e "console.log(\\"api_key=super-secret\\")"',
    cwd: repo,
    timeout_seconds: 10,
  });

  const stdout = await import('node:fs/promises').then(({ readFile }) => readFile(evidence.stdout_path, 'utf8'));
  assert.doesNotMatch(stdout, /super-secret/);
  assert.match(stdout, /\[REDACTED\]/);
});

test('verification commands do not inherit arbitrary secret environment variables', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-command-'));
  const runner = new CommandRunner(repo,{execution:{backend:'trusted-host'}});
  process.env.UNRELATED_SECRET = 'must-not-leak';

  const evidence = await runner.run({
    run_id: 'run-1',
    task_id: 'TASK-env',
    acceptance_ids: [],
    code_snapshot_id: 'SNAP-1',
    command: 'node -e "console.log(process.env.UNRELATED_SECRET || \\"filtered\\")"',
    cwd: repo,
    timeout_seconds: 10,
  });
  delete process.env.UNRELATED_SECRET;

  const stdout = await import('node:fs/promises').then(({ readFile }) => readFile(evidence.stdout_path, 'utf8'));
  assert.match(stdout, /filtered/);
  assert.doesNotMatch(stdout, /must-not-leak/);
});

test('declared nonzero expected exit code can pass acceptance', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-loop-command-'));
  const evidence = await new CommandRunner(repo,{execution:{backend:'trusted-host'}}).run({run_id:'run',task_id:'T',acceptance_ids:['A'],code_snapshot_id:'S',command:'node -e "process.exit(2)"',expected_exit_code:2,cwd:repo,timeout_seconds:10});
  assert.equal(evidence.result,'passed');
});

test('cancelling verification waits for process termination and records error',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'delivery-cancel-verifier-'));const abort=new AbortController();
  const runner=new CommandRunner(repo,{terminationGraceMs:20,execution:{backend:'trusted-host'}});
  const running=runner.run({run_id:'run',task_id:'T',acceptance_ids:[],code_snapshot_id:'S',command:'node -e "setInterval(()=>{},1000)"',cwd:repo,timeout_seconds:20,signal:abort.signal});
  setTimeout(()=>abort.abort(),30);const result=await running;assert.equal(result.result,'error');assert.equal(result.exit_code,130);
});

test('container backend fails closed when the configured runtime is unavailable',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'delivery-isolated-'));
  const runner=new CommandRunner(repo,{execution:{backend:'container',image:'node@sha256:'+'a'.repeat(64),command:'delivery-nonexistent-container-runtime'}});
  const record=await runner.run({run_id:'run',task_id:'T',acceptance_ids:[],code_snapshot_id:'S',command:'touch escaped',cwd:repo,timeout_seconds:1});
  assert.equal(record.result,'error');const {access}=await import('node:fs/promises');await assert.rejects(access(join(repo,'escaped')));
});


test('verification requires explicit host opt-in before running a local command',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'delivery-default-isolation-'));
  const evidence=await new CommandRunner(repo).run({run_id:'run',task_id:'T',acceptance_ids:[],code_snapshot_id:'S',command:'touch unexpected-host-file',cwd:repo,timeout_seconds:1});
  assert.equal(evidence.result,'error');const {access}=await import('node:fs/promises');await assert.rejects(access(join(repo,'unexpected-host-file')));
});


test('container runtime launch errors do not masquerade as project test failures',async()=>{
  const {writeFile,chmod}=await import('node:fs/promises');const repo=await mkdtemp(join(tmpdir(),'delivery-container-error-'));const runtime=join(repo,'runtime');
  await writeFile(runtime,'#!/bin/sh\necho "container daemon unavailable" >&2\nexit 125\n');await chmod(runtime,0o755);
  const runner=new CommandRunner(repo,{execution:{backend:'container',image:'fixture@sha256:'+'a'.repeat(64),command:runtime}});
  const record=await runner.run({run_id:'run',task_id:'T',acceptance_ids:[],code_snapshot_id:'S',command:'true',cwd:repo,timeout_seconds:2});assert.equal(record.result,'error');
});
