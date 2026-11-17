import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentResultSchema } from '../domain/schemas.js';
import type { AgentRequest, AgentResult } from '../domain/types.js';
import { buildWorkerPrompt } from './worker-prompt.js';
import type { WorkerAdapter, WorkerRunOptions } from './worker-adapter.js';

/** Minimal DSH services used by the native worker adapter. */
export interface DshSubagentServices {
  subagents: {
    getProvider(name: string): unknown;
    startActivation(spec: Record<string, unknown>): Promise<DshActivation>;
  };
  agents: {
    get(id: string): DshAgent | undefined;
    list(): DshAgent[];
  };
  /** Subscribe to Session events so the adapter can measure child token usage. */
  onSessionEvent?: (
    listener: (session: { readonly id: string }, event: { readonly type: string; readonly data?: unknown }) => void,
  ) => () => void;
}

export interface DshAgent {
  readonly id: string;
  readonly session?: { readonly header?: { readonly cwd?: string } };
  readonly ctx?: {
    on?: (
      event: string,
      listener: (session: { readonly id: string }, event: { readonly type: string; readonly data?: unknown }) => void,
    ) => () => void;
  };
}

export interface DshSubagentResult {
  output: Array<{ type: string; text?: string }>;
  structured?: unknown;
  diagnostic?: string;
  stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | string;
}

export interface DshActivation {
  childId: string;
  name?: string;
  messageId?: string;
  result: Promise<DshSubagentResult>;
  dispose(): Promise<void>;
}

export interface DshWorkerAdapterOptions {
  host: DshSubagentServices;
  /** Registered `ctx.subagents` provider name. Defaults to the in-process `spawn` provider. */
  provider?: string;
  /** Path to the AgentResult JSON Schema. Defaults to `<pluginRoot>/schemas/agent-result.schema.json`. */
  schemaPath?: string;
  /** Resolve the live Agent that owns the run's subagent tree. */
  resolveParent: (runId: string) => DshAgent | undefined;
  /** Parent used when the initiating Agent is gone (e.g. after a Host restart). */
  fallbackParent?: () => Promise<DshAgent | undefined>;
  /** Optional recursion cap passed to the provider. */
  maxDepth?: number;
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
  'description',
  'title',
]);

function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties') {
      const properties: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(entry as Record<string, unknown>)) {
        properties[name] = sanitizeSchema(schema);
      }
      result.properties = properties;
    } else if (key === 'items' || key === 'oneOf') {
      result[key] = sanitizeSchema(entry);
    } else {
      result[key] = entry;
    }
  }
  return result;
}

function loadOutputSchema(schemaPath: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
  const sanitized = sanitizeSchema(parsed) as Record<string, unknown>;
  if (sanitized.type !== 'object') throw new Error('agent-result schema must be object-rooted');
  return sanitized;
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

function textOf(output: Array<{ type: string; text?: string }>): string {
  return output
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function buildDshWorkerPrompt(request: AgentRequest): string {
  const readOnly = request.role === 'reviewer' || request.role === 'acceptance';
  return [
    buildWorkerPrompt(request),
    '',
    '## DSH execution contract',
    `You are a fresh DSH subagent. Your working directory is: ${request.workdir}`,
    'Use the available file and shell tools to complete exactly this task in that working directory.',
    'Do not ask the user for input; return blockers instead.',
    'Do not call `subagent`, `subagent_fork`, `workflow`, `ralph`, or any `delivery_*` tool, and never start a nested delivery run.',
    'Do not run git commit, git push, git merge, or deploy.',
    readOnly
      ? 'This is a read-only observation role: do not modify, create, or delete files.'
      : 'Change only files inside the declared scope paths.',
    '',
    '## Final result',
    'When the work is complete, call the `structured_output` tool exactly once with the complete AgentResult object.',
    `Set task_id to "${request.task_id}" and status to completed, blocked, or failed.`,
    'Do not finish with a plain text answer: only the structured_output call counts as your result.',
  ].join('\n');
}

/**
 * DSH-native worker adapter.
 *
 * Each engine worker is one fresh DSH subagent with its own session, tools,
 * abort signal, and structured result. The worker is caller-delivered, so its
 * result is captured by this adapter instead of being injected into the
 * initiating Agent's conversation.
 */
export class DshSubagentWorkerAdapter implements WorkerAdapter {
  private readonly options: DshWorkerAdapterOptions;
  private readonly outputSchema: Record<string, unknown>;

  constructor(options: DshWorkerAdapterOptions) {
    this.options = options;
    this.outputSchema = loadOutputSchema(
      options.schemaPath ?? join(process.cwd(), 'schemas', 'agent-result.schema.json'),
    );
  }

  private async parentFor(runId: string): Promise<DshAgent | undefined> {
    const live = this.options.resolveParent(runId);
    if (live !== undefined && this.options.host.agents.get(live.id) === live) return live;
    return await this.options.fallbackParent?.();
  }

  async run(request: AgentRequest, runOptions: WorkerRunOptions = {}): Promise<AgentResult> {
    const parent = await this.parentFor(request.run_id);
    if (parent === undefined) {
      return failedResult(request, 'no live DSH parent Agent is available for this delivery run');
    }
    const providerName = this.options.provider ?? 'spawn';
    if (this.options.host.subagents.getProvider(providerName) === undefined) {
      return failedResult(request, `DSH subagent provider "${providerName}" is not registered`);
    }

    const controller = new AbortController();
    const callerSignal = runOptions.signal;
    const forwardAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    let timedOut = false;
    const timeoutMs = Math.max(1, request.timeout_seconds) * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`worker timed out after ${request.timeout_seconds}s`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const childId = randomUUID();
    let measuredTokens = 0;
    let usageMeasured = false;
    const onUsage = (session: { readonly id: string }, event: { readonly type: string; readonly data?: unknown }): void => {
      if (session.id !== childId || event.type !== 'assistant/message') return;
      const data = event.data as { usage?: { totalTokens?: unknown; inputTokens?: unknown; outputTokens?: unknown } } | undefined;
      const usage = data?.usage;
      if (usage === undefined) return;
      const total = typeof usage.totalTokens === 'number'
        ? usage.totalTokens
        : typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
          ? usage.inputTokens + usage.outputTokens
          : undefined;
      if (total === undefined || !Number.isFinite(total)) return;
      usageMeasured = true;
      measuredTokens += total;
    };
    // Subscribe before start when the Host exposes the event bus; otherwise use
    // the live child Agent's scoped context after start.
    let stopUsage: (() => void) | undefined = this.options.host.onSessionEvent?.(onUsage);

    try {
      const activation = await this.options.host.subagents.startActivation({
        provider: providerName,
        childId,
        label: `${request.role}: ${request.task_id}`,
        cwd: request.workdir,
        prompt: [{ type: 'text', text: buildDshWorkerPrompt(request) }],
        parent,
        outputSchema: this.outputSchema,
        signal: controller.signal,
        delivery: 'caller',
        ...(this.options.maxDepth === undefined ? {} : { maxDepth: this.options.maxDepth }),
      });
      if (stopUsage === undefined) {
        const child = this.options.host.agents.get(activation.childId);
        stopUsage = child?.ctx?.on?.('session/event', onUsage);
      }
      const result = await activation.result;
      if (controller.signal.aborted) {
        return failedResult(
          request,
          timedOut
            ? `DSH worker timed out after ${request.timeout_seconds}s`
            : 'DSH worker aborted',
          usageMeasured ? measuredTokens : undefined,
        );
      }
      if (result.stopReason !== 'completed') {
        return failedResult(
          request,
          `DSH worker ${result.stopReason}${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}`,
          usageMeasured ? measuredTokens : undefined,
        );
      }
      const structured = result.structured ?? (() => {
        const text = textOf(result.output);
        if (text.length === 0) return undefined;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return undefined;
        }
      })();
      if (structured === undefined) {
        return failedResult(
          request,
          'DSH worker completed without a structured AgentResult',
          usageMeasured ? measuredTokens : undefined,
        );
      }
      const parsed = AgentResultSchema.parse(structured) as AgentResult;
      if (parsed.task_id !== request.task_id) {
        return failedResult(
          request,
          `DSH worker task_id mismatch: expected ${request.task_id}, got ${parsed.task_id}`,
          usageMeasured ? measuredTokens : undefined,
        );
      }
      // The child cannot measure its own token usage reliably; omit it so the
      // engine reports usage as incomplete instead of trusting a guess.
      const { token_usage: _ignored, ...authoritative } = parsed;
      return usageMeasured ? { ...authoritative, token_usage: measuredTokens } : authoritative;
    } catch (error) {
      return failedResult(
        request,
        error instanceof Error ? error.message : String(error),
        usageMeasured ? measuredTokens : undefined,
      );
    } finally {
      stopUsage?.();
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    }
  }
}
