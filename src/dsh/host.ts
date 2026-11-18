import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DeliveryRunManager } from '../runtime/run-manager.js';
import { RuntimeFactory } from '../runtime/runtime-factory.js';
import { DeliveryService } from '../service/delivery-service.js';
import { RunRegistry } from '../runtime/run-registry.js';
import { DshSubagentWorkerAdapter } from '../workers/dsh-subagent-adapter.js';
import type { DshAgent } from '../workers/dsh-subagent-adapter.js';
import { DeliveryViewService } from './view-service.js';
import type { RunDetail, RunSummary } from './view-service.js';
import type { StartRunInput } from '../runtime/types.js';
import { recordDecision } from '../controller/decision-journal.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_API_PREFIX = '/delivery-loop';
const MAX_BODY_BYTES = 1_000_000;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'BLOCKED', 'PAUSED', 'WAITING_HUMAN']);

const SAFE_OVERRIDE_KEYS = new Set(['runtime', 'review', 'git', 'workers']);

/** Reject override fields that can weaken the security or verification contract. */
function assertSafeConfigOverride(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config_override must be an object');
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!SAFE_OVERRIDE_KEYS.has(key)) {
      throw new Error(
        `config_override cannot change "${key}"; put it in the approved prepared delivery.yaml instead`,
      );
    }
  }
}

/** Services this plugin requires; optional services are reached through `ctx.get`. */
export const inject = ['tools', 'agents', 'subagents'];

interface DeliveryLoopConfig {
  defaultRepoRoot?: string;
  apiPrefix: string;
  modelInvocableSkill: boolean;
  systemPrompt: boolean;
  subagentProvider: string;
  subagentMaxDepth?: number;
}

interface ParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: readonly string[];
  items?: ParamSpec;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>;
  };
  execute: (args: Record<string, unknown>, exec: ToolExecutionLike) => Promise<unknown>;
}

interface ToolExecutionLike {
  agent?: DshAgent;
  signal?: AbortSignal;
}

function normalizeConfig(raw: unknown): DeliveryLoopConfig {
  const value = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const prefix = typeof value.apiPrefix === 'string' && value.apiPrefix.startsWith('/')
    ? value.apiPrefix.replace(/\/+$/, '')
    : DEFAULT_API_PREFIX;
  return {
    ...(typeof value.defaultRepoRoot === 'string' ? { defaultRepoRoot: value.defaultRepoRoot } : {}),
    apiPrefix: prefix.length > 0 ? prefix : DEFAULT_API_PREFIX,
    modelInvocableSkill: value.modelInvocableSkill !== false,
    systemPrompt: value.systemPrompt !== false,
    subagentProvider: typeof value.subagentProvider === 'string' && value.subagentProvider.length > 0
      ? value.subagentProvider
      : 'spawn',
    ...(typeof value.subagentMaxDepth === 'number' && Number.isInteger(value.subagentMaxDepth) && value.subagentMaxDepth >= 0
      ? { subagentMaxDepth: value.subagentMaxDepth }
      : {}),
  };
}

function newRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `R-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function paramToJson(spec: ParamSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: spec.type, description: spec.description };
  if (spec.enum !== undefined) schema.enum = [...spec.enum];
  if (spec.items !== undefined) schema.items = paramToJson(spec.items);
  return schema;
}

function parametersToJson(specs: Record<string, ParamSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    properties[name] = paramToJson(spec);
    if (spec.required === true) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function validateArgs(specs: Record<string, ParamSpec>, raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('arguments must be a JSON object');
  }
  const args = raw as Record<string, unknown>;
  for (const [name, spec] of Object.entries(specs)) {
    const value = args[name];
    if (value === undefined) {
      if (spec.required === true) throw new Error(`missing required argument: ${name}`);
      continue;
    }
    const valid = spec.type === 'string' ? typeof value === 'string'
      : spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : spec.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
          : spec.type === 'boolean' ? typeof value === 'boolean'
            : spec.type === 'array' ? Array.isArray(value)
              : value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!valid) throw new Error(`argument ${name} must be a ${spec.type}`);
    if (spec.enum !== undefined && !spec.enum.includes(String(value))) {
      throw new Error(`argument ${name} must be one of: ${spec.enum.join(', ')}`);
    }
  }
  return args;
}

function defineTool(options: {
  name: string;
  description: string;
  parameters: Record<string, ParamSpec>;
  execute: (args: Record<string, unknown>, exec: ToolExecutionLike) => Promise<unknown>;
}): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: parametersToJson(options.parameters),
    output: {
      schema: {},
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2).slice(0, 24_000),
      }],
    },
    async execute(raw, exec) {
      return await options.execute(validateArgs(options.parameters, raw), exec);
    },
  };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolveBody, rejectBody) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        rejectBody(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolveBody(body));
    req.on('error', rejectBody);
  });
}

function toolSummary(summary: RunSummary): Record<string, unknown> {
  return {
    run_id: summary.run_id,
    status: summary.status,
    title: summary.title,
    repo_root: summary.repo_root,
    progress: `${summary.done_tasks}/${summary.total_tasks}`,
    task_counts: summary.task_counts,
    current_task_ids: summary.current_task_ids,
    pending_decision_ids: summary.pending_decision_ids,
    last_error: summary.last_error,
    total_tokens_used: summary.total_tokens_used,
    usage_incomplete: summary.usage_incomplete,
    integration_snapshot_id: summary.integration_snapshot_id,
    completion_ref: summary.completion_ref,
  };
}

function inspectPayload(detail: RunDetail): Record<string, unknown> {
  return {
    ...toolSummary(detail),
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    spec_excerpt: detail.spec_excerpt,
    tasks: detail.tasks,
    requirements: detail.requirements,
    acceptance: detail.acceptance,
    decisions: detail.decisions.slice(-60),
    decision_blockers: detail.decision_blockers,
    evidence: detail.evidence.slice(-60),
    files: detail.files,
    artifacts: detail.artifacts.slice(0, 200),
    recent_events: detail.events.slice(-40),
    config: {
      profile: detail.config.profile,
      git_mode: detail.config.git.mode,
      review: detail.config.review,
      verification: detail.config.verification,
      runtime: detail.config.runtime,
    },
  };
}

function registerSkill(ctx: any): void {
  const skills = ctx.get?.('skills');
  if (skills === undefined || skills === null) return;
  let content: string;
  try {
    content = readFileSync(join(PLUGIN_ROOT, 'skills', 'deliver-change', 'SKILL.md'), 'utf8');
  } catch (error) {
    console.warn('[delivery-loop] skill content unavailable:', error);
    return;
  }
  const description = 'Run a generic end-to-end software delivery loop from an approved specification through implementation, verification, independent review, and acceptance. Use when the user explicitly wants autonomous delivery, multi-agent development, or a loop that continues until the work is verified and accepted.';
  ctx.effect(() => skills.register({
    name: 'deliver-change',
    description,
    whenToUse: 'The user explicitly asks for end-to-end delivery, a task DAG, isolated workers, independent review, or autonomous iteration to acceptance.',
    content,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: join(PLUGIN_ROOT, 'skills', 'deliver-change') },
    invocation: { modelInvocable: true, userInvocable: true },
  }), 'delivery-loop: skill');
}

function registerSystemPrompt(ctx: any): void {
  const systemPrompt = ctx.get?.('systemPrompt');
  if (systemPrompt === undefined || systemPrompt === null) return;
  ctx.effect(() => systemPrompt.section({
    name: 'delivery-loop',
    order: 45,
    text: [
      'Delivery Loop is installed.',
      'For an explicitly requested end-to-end delivery (specification, task graph, isolated workers, verification, review, acceptance), load the `deliver-change` skill before preparing the run.',
      'Use the `delivery_*` tools to start, inspect, wait for, pause, resume, cancel, answer decisions, export a report, or finalize a run.',
      'Do not start a delivery run for a single small edit or plan-only work.',
    ].join('\n'),
  }), 'delivery-loop: prompt section');
}

function registerWebApi(ctx: any, options: {
  config: DeliveryLoopConfig;
  view: DeliveryViewService;
  service: DeliveryService;
  token: string;
}): void {
  const webServer = ctx.get?.('webServer');
  if (webServer === undefined || webServer === null) {
    console.warn('[delivery-loop] webServer is unavailable; the delivery view will not load runs over HTTP.');
    return;
  }
  const { config, view, service, token } = options;
  const prefix = config.apiPrefix;
  // The token must reach the page before the client bundle runs. A structured
  // `webserver/index-inject` row does that for both carriers: the Web server
  // renders it into index.html, and the Desktop app receives the same table in
  // its boot payload. `tapIndex` alone never runs on the Desktop, which loads
  // the built client from that payload instead of an HTTP index response.
  const canInjectRow = typeof ctx.on === 'function'
    && typeof webServer.collectIndexInjections === 'function';
  if (canInjectRow) {
    ctx.effect(() => ctx.on('webserver/index-inject', (table: unknown[]) => {
      table.push({ kind: 'global', name: '__DELIVERY_LOOP_TOKEN__', value: token });
    }), 'delivery-loop: view token');
  } else if (typeof webServer.tapIndex === 'function') {
    ctx.effect(() => webServer.tapIndex((html: string) => html.replace(
      '</head>',
      `<script>window.__DELIVERY_LOOP_TOKEN__ = ${JSON.stringify(token)};</script></head>`,
    )), 'delivery-loop: view token');
  } else {
    // The API below still requires either the DSH browser session or the
    // token, so registering it without an injection path cannot expose data.
    console.warn('[delivery-loop] no view-token injection path; the token fallback is unavailable.');
  }
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // DSH's browser session is the primary credential: the Web page sends its
    // cookie, and the Desktop app forwards the same Host cookie on every plugin
    // request. The per-process token remains the fallback for a composition
    // that mounts the web carrier without `ctx.connection`.
    const connection = ctx.get?.('connection');
    const rejection = connection !== undefined && connection !== null
      && typeof connection.requestRejection === 'function'
      ? connection.requestRejection(req) as 401 | 403 | undefined
      : (req.headers['x-delivery-loop-token'] === token ? undefined : 401);
    if (rejection !== undefined) {
      json(res, rejection, { error: rejection === 403 ? 'forbidden' : 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      json(res, 404, { error: 'not found' });
      return;
    }
    const sub = url.pathname.slice(prefix.length).replace(/^\/+/, '').replace(/^api\/?/, '');
    const repoRoot = url.searchParams.get('repo_root') ?? undefined;
    const runId = url.searchParams.get('run_id') ?? undefined;
    try {
      if (req.method === 'GET' && (sub === '' || sub === 'health')) {
        json(res, 200, { ok: true, plugin: 'delivery-loop', version: '0.2.0', prefix });
        return;
      }
      if (req.method === 'GET' && sub === 'runs') {
        json(res, 200, { runs: await view.listRuns(repoRoot) });
        return;
      }
      if (req.method === 'GET' && sub === 'run') {
        if (runId === undefined) throw new Error('run_id is required');
        json(res, 200, await view.getRun(runId, repoRoot, {
          includeFiles: url.searchParams.get('include_files') !== '0',
          includeArtifacts: url.searchParams.get('include_artifacts') !== '0',
        }));
        return;
      }
      if (req.method === 'GET' && sub === 'file') {
        if (runId === undefined) throw new Error('run_id is required');
        const path = url.searchParams.get('path');
        if (path === null || path.length === 0) throw new Error('path is required');
        const source = url.searchParams.get('source') ?? 'worktree';
        if (source !== 'worktree' && source !== 'repo' && source !== 'artifact') {
          throw new Error('source must be worktree, repo, or artifact');
        }
        const taskId = url.searchParams.get('task_id') ?? undefined;
        json(res, 200, await view.readFile(runId, path, source, repoRoot, taskId));
        return;
      }
      if (req.method === 'GET' && sub === 'diff') {
        if (runId === undefined) throw new Error('run_id is required');
        const path = url.searchParams.get('path');
        if (path === null || path.length === 0) throw new Error('path is required');
        const taskId = url.searchParams.get('task_id') ?? undefined;
        json(res, 200, { path, diff: await view.readDiff(runId, path, repoRoot, taskId) });
        return;
      }
      if (req.method === 'POST' && sub === 'action') {
        const raw = await readBody(req);
        const body = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
        const action = body.action;
        if (typeof action !== 'string') throw new Error('action is required');
        const targetRun = typeof body.run_id === 'string' ? body.run_id : runId;
        if (targetRun === undefined) throw new Error('run_id is required');
        const targetRepo = typeof body.repo_root === 'string' ? body.repo_root : repoRoot;
        const base = {
          run_id: targetRun,
          ...(targetRepo === undefined ? {} : { repo_root: targetRepo }),
        };
        if (action === 'pause') json(res, 200, await service.delivery_pause(base));
        else if (action === 'resume') {
          json(res, 200, await service.delivery_resume({
            ...base,
            ...(typeof body.max_total_tokens === 'number' ? { max_total_tokens: body.max_total_tokens } : {}),
            ...(typeof body.max_duration_hours === 'number' ? { max_duration_hours: body.max_duration_hours } : {}),
            ...(typeof body.max_task_attempts === 'number' ? { max_task_attempts: body.max_task_attempts } : {}),
          }));
        }
        else if (action === 'cancel') json(res, 200, await service.delivery_cancel(base));
        else if (action === 'respond') {
          if (typeof body.decision_id !== 'string' || typeof body.response !== 'string') {
            throw new Error('decision_id and response are required');
          }
          json(res, 200, await service.delivery_respond({
            ...base,
            decision_id: body.decision_id,
            response: body.response,
          }));
        } else if (action === 'export_report') {
          if (targetRepo === undefined) throw new Error('repo_root is required to export a report');
          json(res, 200, await service.delivery_export_report({ run_id: targetRun, repo_root: targetRepo }));
        } else if (action === 'finalize') {
          const modes = ['prepare-only', 'commit', 'branch', 'push', 'merge'];
          if (typeof body.mode !== 'string' || !modes.includes(body.mode) || typeof body.confirmation !== 'string') {
            throw new Error('mode must be one of: prepare-only, commit, branch, push, merge');
          }
          json(res, 200, await service.delivery_finalize({
            ...base,
            mode: body.mode as never,
            confirmation: body.confirmation,
          }));
        } else {
          throw new Error(`unknown action: ${action}`);
        }
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: prefix,
    handler,
  }), 'delivery-loop: web api');
}

/**
 * Host half of the Delivery Loop bundle: native tools, the delivery view API,
 * the run skill, and a short prompt section.
 */
export function apply(ctx: any, rawConfig: unknown): void {
  const config = normalizeConfig(rawConfig);
  const registry = new RunRegistry();
  const agents = ctx.get?.('agents');
  const subagents = ctx.get?.('subagents');
  const parentByRun = new Map<string, DshAgent>();
  const rememberParent = (runId: string, agent: DshAgent): void => {
    if (parentByRun.size >= 64) {
      const oldest = parentByRun.keys().next().value;
      if (oldest !== undefined) parentByRun.delete(oldest);
    }
    parentByRun.set(runId, agent);
  };

  let coordinatorHandle: { dispose(): Promise<void> } | undefined;
  let coordinator: DshAgent | undefined;
  const fallbackParent = async (): Promise<DshAgent | undefined> => {
    // Prefer a live, tool-owning Agent. The initiating Agent is normally
    // remembered by every delivery tool call, so this path is only for a run
    // recovered without one. A freshly created coordinator is the last resort:
    // it has a fresh context but may inherit a minimal tool set.
    const live = agents?.list?.()[0] as DshAgent | undefined;
    if (live !== undefined) return live;
    if (coordinator !== undefined && agents?.get?.(coordinator.id) === coordinator) return coordinator;
    if (typeof agents?.create !== 'function') return undefined;
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
    const agentOptions = selection === undefined || selection === null
      ? undefined
      : {
        ...(typeof selection.provider === 'string' ? { provider: selection.provider } : {}),
        ...(typeof selection.model === 'string' ? { model: selection.model } : {}),
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
    try {
      const handle = await agents.create({
        sessionId: `delivery-coordinator-${randomUUID()}`,
        meta: { cwd: process.cwd() },
        ...(agentOptions === undefined ? {} : { agentOptions }),
      });
      coordinatorHandle = handle;
      coordinator = handle.agent as DshAgent;
      return coordinator;
    } catch (error) {
      console.warn('[delivery-loop] cannot create a fallback coordinator Agent:', error);
      return undefined;
    }
  };
  ctx.effect(() => () => {
    void coordinatorHandle?.dispose();
  }, 'delivery-loop: coordinator');

  const workerAdapter = agents !== undefined && subagents !== undefined
    ? new DshSubagentWorkerAdapter({
      host: {
        subagents,
        agents,
        ...(typeof ctx.on === 'function'
          ? { onSessionEvent: (listener: (session: { readonly id: string }, event: { readonly type: string; readonly data?: unknown }) => void) => ctx.on('session/event', listener) }
          : {}),
      },
      provider: config.subagentProvider,
      schemaPath: join(PLUGIN_ROOT, 'schemas', 'agent-result.schema.json'),
      resolveParent: (runId) => parentByRun.get(runId),
      fallbackParent,
      ...(config.subagentMaxDepth === undefined ? {} : { maxDepth: config.subagentMaxDepth }),
    })
    : undefined;
  if (workerAdapter === undefined) {
    throw new Error('Delivery Loop requires the DSH `agents` and `subagents` services');
  }

  const manager = new DeliveryRunManager({
    pluginRoot: PLUGIN_ROOT,
    runtimeFactory: new RuntimeFactory({
      pluginRoot: PLUGIN_ROOT,
      workerAdapter,
    }),
    registry,
  });
  const service = new DeliveryService(
    manager,
    async (action, handle, context) => await manager.executeFinalize(action, handle, context),
  );
  const view = new DeliveryViewService(registry);
  const viewToken = randomBytes(24).toString('hex');

  const resolveRepo = async (explicit: unknown, exec: ToolExecutionLike): Promise<string> => {
    if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit);
    const workingDirectory = ctx.get?.('workingDirectory');
    if (workingDirectory !== undefined && workingDirectory !== null && exec.agent !== undefined) {
      const cwd = await workingDirectory.ensure(exec.agent, exec.signal);
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
    if (config.defaultRepoRoot !== undefined) return resolve(config.defaultRepoRoot);
    return process.cwd();
  };

  const tools: ToolDefinition[] = [
    defineTool({
      name: 'delivery_start',
      description: 'Start an approved end-to-end delivery run from a prepared specification directory (.delivery/prepared/<draft-id> with spec.md and task-graph.json). Returns the run id and initial status.',
      parameters: {
        prepared_directory: { type: 'string', required: true, description: 'Directory containing spec.md, task-graph.json, and optional delivery.yaml.' },
        repo_root: { type: 'string', description: 'Target Git repository root. Omit it to use the Session working directory.' },
        run_id: { type: 'string', description: 'Optional stable run id. Defaults to a generated timestamped id.' },
        config_override: { type: 'object', description: 'Optional runtime/review/git/worker overrides. Verification policy must live in the approved delivery.yaml.' },
        allow_trusted_host: { type: 'boolean', description: 'Set to true only after the user explicitly approves running verification commands on the host. Required for trusted-host verification.' },
      },
      async execute(args, exec) {
        const repoRoot = await resolveRepo(args.repo_root, exec);
        const runId = typeof args.run_id === 'string' && args.run_id.length > 0
          ? args.run_id
          : newRunId();
        if (exec.agent !== undefined) rememberParent(runId, exec.agent);
        if (args.config_override !== undefined) assertSafeConfigOverride(args.config_override);
        const input: StartRunInput = {
          repo_root: repoRoot,
          prepared_directory: String(args.prepared_directory),
          run_id: runId,
          ...(args.allow_trusted_host === true ? { allow_trusted_host: true } : {}),
          ...(args.config_override !== null && typeof args.config_override === 'object'
            ? { config_override: args.config_override as never }
            : {}),
        };
        const handle = await manager.start(input);
        if (handle.state.config.verification.execution?.backend === 'trusted-host') {
          await recordDecision(handle.store, {
            run_id: handle.state.run_id,
            phase: 'prepare',
            code: 'trusted_host_verification_acknowledged',
            title: '已确认在宿主机执行验证命令',
            detail: '启动调用显式传入 allow_trusted_host=true；该模式没有容器隔离。',
            outcome: 'info',
          });
        }
        return toolSummary(await view.getStatus(handle.state.run_id, handle.repoRoot));
      },
    }),
    defineTool({
      name: 'delivery_status',
      description: 'Return a bounded delivery status: progress counts, current tasks, pending human decisions, recent decisions, and the last error. Omit run_id to list runs in the Session repository.',
      parameters: {
        run_id: { type: 'string', description: 'Run id. Omit it to list runs in the current repository.' },
        repo_root: { type: 'string', description: 'Target repository root. Omit it to use the Session working directory.' },
      },
      async execute(args, exec) {
        if (typeof args.run_id !== 'string') {
          const repoRoot = await resolveRepo(args.repo_root, exec);
          return { runs: (await view.listRuns(repoRoot)).map(toolSummary) };
        }
        const repoRoot = args.repo_root === undefined ? undefined : await resolveRepo(args.repo_root, exec);
        await manager.ensureActive(String(args.run_id), repoRoot);
        const detail = await view.getRun(args.run_id, repoRoot, { includeFiles: false, includeArtifacts: false });
        return {
          ...toolSummary(detail),
          tasks: detail.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            attempt: task.attempt,
            max_attempts: task.max_attempts,
            origin: task.origin,
            summary: task.last_summary,
            failure: task.failure_context?.summary ?? null,
          })),
          decisions: detail.decisions.slice(-20),
          decision_blockers: detail.decision_blockers,
          recent_events: detail.events.slice(-10),
        };
      },
    }),
    defineTool({
      name: 'delivery_inspect',
      description: 'Read the full delivery view payload for one run: task graph, requirements, acceptance, decision timeline, evidence index, changed files, artifacts, and the spec excerpt.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'Run id.' },
        repo_root: { type: 'string', description: 'Target repository root. Omit it to resolve from the run registry.' },
      },
      async execute(args, exec) {
        const repoRoot = args.repo_root === undefined ? undefined : await resolveRepo(args.repo_root, exec);
        await manager.ensureActive(String(args.run_id), repoRoot);
        return inspectPayload(await view.getRun(String(args.run_id), repoRoot));
      },
    }),
    defineTool({
      name: 'delivery_watch',
      description: 'Wait for delivery progress or a terminal state, then return the current status. Use it after starting or resuming a run instead of polling in a tight loop.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'Run id.' },
        repo_root: { type: 'string', description: 'Target repository root. Omit it to use the Session working directory.' },
        timeout_ms: { type: 'integer', description: 'Maximum wait in milliseconds, 1 through 300000. Defaults to 30000.' },
      },
      async execute(args, exec) {
        const repoRoot = args.repo_root === undefined ? undefined : await resolveRepo(args.repo_root, exec);
        const timeout = Math.max(1, Math.min(typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000, 300_000));
        const deadline = Date.now() + timeout;
        await manager.ensureActive(String(args.run_id), repoRoot);
        for (;;) {
          const status = await view.getStatus(String(args.run_id), repoRoot);
          if (TERMINAL_STATUSES.has(status.status) || Date.now() >= deadline) {
            return toolSummary(status);
          }
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 750));
        }
      },
    }),
    defineTool({
      name: 'delivery_respond',
      description: 'Answer one pending human decision by decision id. Use delivery_status first to read the exact decision id, question, and options.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'Run id.' },
        decision_id: { type: 'string', required: true, description: 'Pending decision id from delivery_status.' },
        response: { type: 'string', required: true, description: 'The user answer or decision.' },
        repo_root: { type: 'string', description: 'Target repository root. Omit it to use the Session working directory.' },
      },
      async execute(args, exec) {
        const runId = String(args.run_id);
        const repoRoot = args.repo_root === undefined ? undefined : await resolveRepo(args.repo_root, exec);
        await service.delivery_respond({
          run_id: runId,
          decision_id: String(args.decision_id),
          response: String(args.response),
          ...(repoRoot === undefined ? {} : { repo_root: repoRoot }),
        });
        return toolSummary(await view.getStatus(runId, repoRoot));
      },
    }),
    defineTool({
      name: 'delivery_pause',
      description: 'Request a pause for a delivery run. The scheduler stops after the current step and keeps its durable state.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'Run id.' },
        repo_root: { type: 'string', description: 'Target repository root. Omit it to use the Session working directory.' },
      },
      async execute(args, exec) {
        const runId = String(args.run_id);
        const repoRoot = args.repo_root === undefined ? undefined : await resolveRepo(args.repo_root, exec);
        await service.delivery_pause({ run_id: runId, ...(repoRoot === undefined ? {} : { repo_root: repoRoot }) });
        return toolSummary(await view.getStatus(runId, repoRoot));
      },
    }),
    defineTool({
      name: 'delivery_resume',
      description: 'Resume a paused, queued, or blocked delivery run. A resumed run can also raise its token, duration, or per-task retry budget; pass only increases after explicit user confirmation.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'Run id.' },
        repo_root: { type: 'string', description: 'Target repository root. Omit it to use the Session working directory.' },
        max_total_tokens: { type: 'integer', description: 'Optional increased token budget for this run.' },
        max_duration_hours: { type: 'number', description: 'Optional increased wall-clock budget in hours.' },
        max_task_attempts: { type: 'integer', description: 'Optional increased per-task retry limit.' },
      },
      async execute(args, exec) {
        const runId = String(args.run_id);
        const repoRoot = args.repo_root === undefined ? undefined : await resolveRepo(args.repo_root, exec);
        await service.delivery_resume({
          run_id: runId,
          ...(repoRoot === undefined ? {} : { repo_root: repoRoot }),
          ...(typeof args.max_total_tokens === 'number' ? { max_total_tokens: args.max_total_tokens } : {}),
          ...(typeof args.max_duration_hours === 'number' ? { max_duration_hours: args.max_duration_hours } : {}),
          ...(typeof args.max_task_attempts === 'number' ? { max_task_attempts: args.max_task_attempts } : {}),
        });
        return toolSummary(await view.getStatus(runId, repoRoot));
      },
    }),
    defineTool({
      name: 'delivery_cancel',
      description: 'Cancel a delivery run. Running workers are aborted and unfinished tasks become CANCELLED; this cannot be undone.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'Run id.' },
        repo_root: { type: 'string', description: 'Target repository root. Omit it to use the Session working directory.' },
      },
      async execute(args, exec) {
        const runId = String(args.run_id);
        const repoRoot = args.repo_root === undefined ? undefined : await resolveRepo(args.repo_root, exec);
        await service.delivery_cancel({ run_id: runId, ...(repoRoot === undefined ? {} : { repo_root: repoRoot }) });
        return toolSummary(await view.getStatus(runId, repoRoot));
      },
    }),
    defineTool({
      name: 'delivery_export_report',
      description: 'Write the Markdown delivery report into the run directory under reports/final.md.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'Run id.' },
        repo_root: { type: 'string', description: 'Target repository root. Omit it to use the Session working directory.' },
      },
      async execute(args) {
        const runId = String(args.run_id);
        const repoRoot = typeof args.repo_root === 'string'
          ? resolve(args.repo_root)
          : await view.resolveRepoRoot(runId);
        return await service.delivery_export_report({ run_id: runId, repo_root: repoRoot });
      },
    }),
    defineTool({
      name: 'delivery_finalize',
      description: 'Apply an explicitly confirmed post-completion Git action. The default delivery mode is prepare-only: no commit, push, merge, or deployment.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'Run id.' },
        mode: { type: 'string', required: true, enum: ['prepare-only', 'commit', 'branch', 'push', 'merge'], description: 'Finalization mode.' },
        confirmation: { type: 'string', required: true, description: 'Explicit user confirmation for the exact run id and mode, formatted as <run-id>:<mode>.' },
        repo_root: { type: 'string', description: 'Target repository root. Omit it to resolve from the run registry.' },
      },
      async execute(args) {
        const runId = String(args.run_id);
        const repoRoot = typeof args.repo_root === 'string'
          ? resolve(args.repo_root)
          : await view.resolveRepoRoot(runId);
        return await service.delivery_finalize({
          run_id: runId,
          mode: args.mode as never,
          confirmation: String(args.confirmation),
          repo_root: repoRoot,
        });
      },
    }),
  ];

  for (const definition of tools) {
    const execute = definition.execute;
    // A Host restart or plugin reload drops the in-memory run -> initiating
    // Agent map. Any later delivery_* call addresses a run from a live Agent
    // that owns tools, so record that Agent as the run's parent before the
    // action. Without this, recovered workers fall back to an arbitrary Agent
    // (or a tool-less coordinator) and cannot edit files.
    definition.execute = async (args, exec) => {
      const runId = typeof args.run_id === 'string' && args.run_id.length > 0 ? args.run_id : undefined;
      if (runId !== undefined && exec.agent !== undefined) rememberParent(runId, exec.agent);
      return await execute(args, exec);
    };
    ctx.tools.register(definition);
  }
  registerWebApi(ctx, { config, view, service, token: viewToken });
  if (config.modelInvocableSkill) registerSkill(ctx);
  if (config.systemPrompt) registerSystemPrompt(ctx);

  console.info(`[delivery-loop] host plugin ready (root ${PLUGIN_ROOT}, api ${config.apiPrefix})`);
}
