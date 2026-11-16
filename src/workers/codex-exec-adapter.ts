import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { AgentResultSchema } from '../domain/schemas.js';
import type { AgentRequest, AgentResult } from '../domain/types.js';
import { runSupervisedProcess } from '../runtime/process-supervisor.js';
import type { WorkerAdapter, WorkerRunOptions } from './worker-adapter.js';

export interface CodexExecArgsOptions {
  resultPath: string;
  schemaPath: string;
  profile?: string;
}

export function buildWorkerPrompt(request: AgentRequest): string {
  const skillInstructions = request.required_skills
    .map(
      (skill) =>
        `- ${skill.skill_id}: 读取并遵守 ${join(skill.root, skill.entry)}（SHA-256 ${skill.sha256}）`,
    )
    .join('\n');

  const frozenContext = 'context' in request && request.context !== undefined
    ? ['## Frozen Context', JSON.stringify(request.context, null, 2), '']
    : [];

  return [
    '# Delivery Worker Contract',
    '你是由 deliveryd 启动的单一任务 Worker。',
    '只完成当前任务；完成当前任务后停止，不得继续调度其他任务。',
    '不得递归创建交付运行或交付Worker，不得等待用户直接输入；需要人工决策时返回 blockers。',
    '不得执行 git commit、git push、git merge 或部署。',
    'Worker 的 completed 只是提交结果，Coordinator 会独立验证。',
    '',
    `Role: ${request.role}`,
    `Task: ${request.task_id}`,
    `Objective: ${request.objective}`,
    `Requirements: ${request.requirement_ids.join(', ') || '(none)'}`,
    `Acceptance: ${request.acceptance_ids.join(', ') || '(none)'}`,
    `Allowed paths: ${request.scope_paths.join(', ') || '(none)'}`,
    '',
    '## Required Skills',
    skillInstructions || '- 无外部 Skill；使用内置评审规则和当前任务契约。',
    '',
    ...frozenContext,
    '## Constraints',
    ...request.constraints.map((constraint) => `- ${constraint}`),
    '',
    '## Context files',
    ...request.context_files.map((file) => `- ${file}`),
    '',
    '## Verification commands',
    ...request.verification_commands.map((command) => `- ${command}`),
    '',
    '最终输出必须严格符合 AgentResult JSON Schema。',
  ].join('\n');
}

export function extractTokenUsage(jsonl: string): number | undefined {
  return extractMeasuredTokenUsage(jsonl);
}

function extractMeasuredTokenUsage(jsonl: string): number | undefined {
  let largestTotal = 0;
  let measured = false;
  const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const totals = value.totals as Record<string, unknown> | undefined;
      const usage = value.usage as Record<string, unknown> | undefined;
      const cumulativeTotal = totals?.total_tokens;
      if (validCount(cumulativeTotal)) {
        measured = true;
        largestTotal = Math.max(largestTotal, cumulativeTotal);
      }
      if (value.type === 'turn.completed' && usage) {
        const explicitTotal = usage.total_tokens;
        const input = usage.input_tokens;
        const output = usage.output_tokens;
        if (validCount(explicitTotal)) {
          measured = true;
          largestTotal = Math.max(largestTotal, explicitTotal);
        } else if (validCount(input) && validCount(output) && validCount(input + output)) {
          measured = true;
          largestTotal = Math.max(largestTotal, input + output);
        }
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return measured ? largestTotal : undefined;
}

export function buildCodexExecArgs(
  request: AgentRequest,
  options: CodexExecArgsOptions,
): string[] {
  const sandbox = request.role === 'reviewer' || request.role === 'acceptance'
    ? 'read-only'
    : 'workspace-write';
  const args = [
    'exec',
    '--json',
    '--output-schema',
    options.schemaPath,
    '--output-last-message',
    options.resultPath,
    '-C',
    request.workdir,
    '-s',
    sandbox,
  ];
  if (options.profile !== undefined) {
    args.push('--profile', options.profile);
  }
  args.push(buildWorkerPrompt(request));
  return args;
}

export interface CodexExecAdapterOptions {
  schemaPath: string;
  command?: string;
  profileByRole?: Partial<Record<AgentRequest['role'], string>>;
  terminationGraceMs?: number;
  diagnosticDirectory?: string;
}

function failedResult(
  request: AgentRequest,
  summary: string,
  tokenUsage?: number,
): AgentResult {
  return {
    task_id: request.task_id,
    status: 'failed',
    summary,
    files_changed: [],
    commands_run: [],
    findings: [],
    remaining_risks: [],
    suggested_tasks: [],
    blockers: [],
    ...(tokenUsage === undefined ? {} : { token_usage: tokenUsage }),
  };
}

function sanitizeDiagnostics(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer REDACTED')
    .replace(/((?:OPENAI|ANTHROPIC|AWS|API)[_-]?API[_-]?KEY\s*[:=]\s*)([^\s"']+)/gi, '$1REDACTED');
}

export class CodexExecAdapter implements WorkerAdapter {
  private readonly options: CodexExecAdapterOptions;

  constructor(options: CodexExecAdapterOptions) {
    this.options = options;
  }

  async run(request: AgentRequest, runOptions: WorkerRunOptions = {}): Promise<AgentResult> {
    if (runOptions.signal?.aborted) {
      return failedResult(request, 'worker aborted before spawn');
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-worker-'));
    const resultPath = join(temporaryDirectory, 'result.json');
    const jsonlPath = join(temporaryDirectory, 'events.jsonl');
    const stderrPath = join(temporaryDirectory, 'stderr.log');
    const profile =
      runOptions.profile ??
      this.options.profileByRole?.[request.role] ??
      process.env[`DELIVERY_CODEX_PROFILE_${request.role.toUpperCase()}`];
    const args = buildCodexExecArgs(request, {
      resultPath,
      schemaPath: this.options.schemaPath,
      ...(profile === undefined ? {} : { profile }),
    });

    try {
      const processResult = await runSupervisedProcess({
        command: this.options.command ?? process.env.DELIVERY_CODEX_BIN ?? 'codex',
        args,
        timeoutMs: request.timeout_seconds * 1000,
        terminationGraceMs: this.options.terminationGraceMs ?? 5_000,
        stdoutPath: jsonlPath,
        stderrPath,
        ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
      });
      const jsonl = await readFile(jsonlPath, 'utf8');
      const measuredTokenUsage = extractMeasuredTokenUsage(jsonl);
      if (processResult.exitCode !== 0) {
        return failedResult(
          request,
          `codex exec ${processResult.outcome} with code ${processResult.exitCode}`,
          measuredTokenUsage,
        );
      }
      const raw = JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
      const parsed = AgentResultSchema.parse(raw) as AgentResult;
      if (parsed.task_id !== request.task_id) {
        return failedResult(
          request,
          `worker result task_id mismatch: expected ${request.task_id}, got ${parsed.task_id}`,
          measuredTokenUsage,
        );
      }
      const { token_usage: _reportedTokenUsage, ...authoritativeResult } = parsed;
      return {
        ...authoritativeResult,
        ...(measuredTokenUsage === undefined ? {} : { token_usage: measuredTokenUsage }),
      };
    } catch (error) {
      let measuredUsage: number | undefined;
      try {
        measuredUsage = extractMeasuredTokenUsage(await readFile(jsonlPath, 'utf8'));
      } catch {
        // The process may fail before producing an event log.
      }
      return failedResult(
        request,
        error instanceof Error ? error.message : String(error),
        measuredUsage,
      );
    } finally {
      if (this.options.diagnosticDirectory) {
        const destination = join(
          this.options.diagnosticDirectory,
          basename(temporaryDirectory),
        );
        await mkdir(destination, { recursive: true });
        for (const [source, name] of [
          [jsonlPath, 'events.jsonl'],
          [stderrPath, 'stderr.log'],
          [resultPath, 'result.json'],
        ] as const) {
          try {
            await writeFile(
              join(destination, name),
              sanitizeDiagnostics(await readFile(source, 'utf8')),
              'utf8',
            );
          } catch {
            // A process can fail before producing every artifact.
          }
        }
      }
      if (process.env.DELIVERY_KEEP_WORKER_LOGS !== '1') {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }
}
