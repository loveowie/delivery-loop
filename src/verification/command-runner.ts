import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSupervisedProcess } from '../runtime/process-supervisor.js';
import type { EvidenceRecord, VerificationExecution } from '../domain/types.js';
import { EvidenceStore } from './evidence-store.js';

export interface VerificationRequest {
  run_id: string;
  task_id: string;
  acceptance_ids: string[];
  code_snapshot_id: string;
  command: string;
  cwd: string;
  timeout_seconds: number;
  baseline_id?: string;
  expected_exit_code?: number;
  signal?: AbortSignal;
}

interface ProcessOutcome {
  exitCode: number;
  interrupted: boolean;
  stdout: string;
  stderr: string;
}

export function redactLog(content: string): string {
  return content
    .replace(/((?:api[_-]?key|token|password|cookie|secret)\s*[=:]\s*)(\S+)/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*bearer\s+)(\S+)/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

async function runShell(request: VerificationRequest, terminationGraceMs: number, execution: VerificationExecution): Promise<ProcessOutcome> {
  const allowedEnvironment = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'CI', 'JAVA_HOME', 'M2_HOME', 'MAVEN_HOME', 'GRADLE_USER_HOME', 'CARGO_HOME', 'GOPATH', 'GOCACHE'];
  const env = Object.fromEntries(allowedEnvironment.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const directory = await mkdtemp(join(tmpdir(), 'delivery-verification-'));
  const stdoutPath = join(directory, 'stdout');
  const stderrPath = join(directory, 'stderr');
  const containerName = `delivery-verify-${randomUUID()}`;
  let containerStarted = false;
  try {
    if (request.signal?.aborted) return {exitCode:130,interrupted:true,stdout:'',stderr:'verification cancelled before spawn'};
    let command = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    let args = process.platform === 'win32' ? ['/d', '/s', '/c', request.command] : ['-c', request.command];
    if (execution.backend === 'container') {
      if (execution.image === undefined || !/^.+@sha256:[a-f0-9]{64}$/.test(execution.image)) throw new Error('container verification requires an explicitly pinned image digest');
      const source = join(directory, 'source');
      await cp(request.cwd, source, { recursive: true, dereference: false, filter: path => !['.git', '.delivery'].includes(path.split('/').at(-1) ?? '') });
      // Source is mounted read-only. Build output and temporary files belong in /tmp.
      command = execution.command ?? 'docker';
      containerStarted = true;
      args = ['run','--name',containerName,'--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=2g','--cpus=2','--user=65534:65534','--tmpfs=/tmp:rw,nosuid,nodev,size=512m','--mount',`type=bind,src=${source},dst=/workspace,readonly`,'--workdir=/workspace','--env=HOME=/tmp',execution.image,'/bin/sh','-c',request.command];
    }
    const result = await runSupervisedProcess({
      command,
      args,
      cwd: request.cwd,
      env: { ...env, HOME: directory, USERPROFILE: directory },
      timeoutMs: request.timeout_seconds * 1000,
      terminationGraceMs,
      stdoutPath,
      stderrPath,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return { exitCode: result.exitCode, interrupted: result.outcome !== 'exited' || result.signal !== null || (execution.backend === 'container' && [125, 126, 127].includes(result.exitCode)), stdout: await readFile(stdoutPath, 'utf8'), stderr: await readFile(stderrPath, 'utf8') };
  } catch(error) {
    return {exitCode:1,interrupted:true,stdout:'',stderr:error instanceof Error ? error.message : String(error)};
  } finally {
    if (containerStarted) {
      // Killing a container client does not guarantee its container stopped. Reconcile by unique name.
      try {
        await runSupervisedProcess({command:execution.command ?? 'docker',args:['rm','--force',containerName],timeoutMs:10_000,terminationGraceMs,stdoutPath:join(directory,'cleanup.stdout'),stderrPath:join(directory,'cleanup.stderr')});
      } catch { /* The runtime was unavailable or the --rm container already disappeared. */ }
    }
    await rm(directory, {recursive:true,force:true});
  }
}

export class CommandRunner {
  private readonly evidenceStore: EvidenceStore;

  constructor(repoRoot: string, private readonly options: { terminationGraceMs?: number; execution?: VerificationExecution } = {}) {
    this.evidenceStore = new EvidenceStore(repoRoot);
  }

  async run(request: VerificationRequest): Promise<EvidenceRecord> {
    const startedAt = new Date().toISOString();
    const outcome = await runShell(request, this.options.terminationGraceMs ?? 5_000, this.options.execution ?? { backend: 'container' });
    const finishedAt = new Date().toISOString();
    const id = `E-${randomUUID()}`;
    const stdoutPath = await this.evidenceStore.write(
      request.run_id,
      id,
      'stdout',
      redactLog(outcome.stdout),
    );
    const stderrPath = await this.evidenceStore.write(
      request.run_id,
      id,
      'stderr',
      redactLog(outcome.stderr),
    );
    return {
      id,
      run_id: request.run_id,
      task_id: request.task_id,
      acceptance_ids: request.acceptance_ids,
      code_snapshot_id: request.code_snapshot_id,
      command: request.command,
      cwd: request.cwd,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: outcome.exitCode,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      ...(request.baseline_id === undefined ? {} : { baseline_id: request.baseline_id }),
      result: outcome.interrupted ? 'error' : outcome.exitCode === (request.expected_exit_code ?? 0) ? 'passed' : 'failed',
    };
  }
}
