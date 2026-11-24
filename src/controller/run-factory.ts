import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { parse as parseYaml } from 'yaml';
import { loadConfig, mergeDeep } from '../config/config.js';
import { SettingsStore } from '../config/settings.js';
import { TaskGraphSchema, validateTaskGraph } from '../domain/schemas.js';
import { validateDeliveryContract } from '../domain/contract.js';
import type { DeepPartial, DeliveryConfig, RunState, TaskGraph } from '../domain/types.js';
import { StateStore } from '../state/state-store.js';
import {
  NodeGitInspector,
  getRepositoryContext,
} from '../workspace/repository-context.js';

export interface RepositoryInspection {
  canonical_root: string;
  baseline_commit: string;
}

export interface RepositoryInspector {
  inspect(repoRoot: string): Promise<RepositoryInspection>;
}

export interface CreatePreparedRunInput {
  repo_root: string;
  prepared_directory: string;
  run_id?: string | undefined;
  config_override?: DeepPartial<DeliveryConfig> | undefined;
  /** Explicit user confirmation for host-shell verification. */
  allow_trusted_host?: boolean | undefined;
}

export interface PreparedRunFactoryOptions {
  inspector: RepositoryInspector;
  /** Defaults to the global Delivery view settings store. */
  settings?: SettingsStore;
}

function generatedRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `R-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export class PreparedRunFactory {
  private readonly options: PreparedRunFactoryOptions;

  constructor(options: PreparedRunFactoryOptions | RepositoryInspector) {
    const legacy = options as RepositoryInspector;
    this.options = typeof legacy.inspect === 'function'
      ? { inspector: legacy }
      : options as PreparedRunFactoryOptions;
  }

  async create(input: CreatePreparedRunInput): Promise<RunState> {
    const repoRoot = resolve(input.repo_root);
    const preparedDirectory = resolve(input.prepared_directory);
    const inspection = await this.options.inspector.inspect(repoRoot);
    let preparedConfig: DeepPartial<DeliveryConfig> = {};
    try {
      preparedConfig = (parseYaml(
        await readFile(join(preparedDirectory, 'delivery.yaml'), 'utf8'),
      ) ?? {}) as DeepPartial<DeliveryConfig>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    // Budget settings from the view panel sit above the prepared spec's
    // runtime block (a planner writes one into every spec) and below an
    // explicit per-run `config_override`, so a human can raise a budget
    // without editing YAML while a caller can still pin one value for a run.
    const settingsRuntime = await (this.options.settings ?? new SettingsStore())
      .mergedRuntime(inspection.canonical_root);
    const withSettings: DeepPartial<DeliveryConfig> = Object.keys(settingsRuntime).length === 0
      ? preparedConfig
      : mergeDeep(preparedConfig, { runtime: settingsRuntime });
    const config = await loadConfig(
      inspection.canonical_root,
      mergeDeep(withSettings, input.config_override),
    );
    if (
      config.verification.execution?.backend === 'trusted-host' &&
      input.allow_trusted_host !== true
    ) {
      throw new Error(
        'trusted-host verification requires explicit user confirmation; pass allow_trusted_host=true only after the user approves running verification commands on the host',
      );
    }
    const runId = input.run_id ?? generatedRunId();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) ||
      runId.includes('..') ||
      runId.endsWith('.') ||
      runId.endsWith('.lock')
    ) {
      throw new Error(`invalid run id: ${runId}`);
    }

    const graphPath = join(preparedDirectory, 'task-graph.json');
    const parsedGraph = TaskGraphSchema.parse(
      JSON.parse(await readFile(graphPath, 'utf8')) as unknown,
    ) as TaskGraph;
    const graph: TaskGraph = { ...parsedGraph, run_id: runId };
    const graphValidation = validateTaskGraph(graph);
    if (!graphValidation.ok) {
      throw new Error(`invalid task graph: ${graphValidation.errors.join('; ')}`);
    }
    const contractErrors = validateDeliveryContract(graph, config);
    if (contractErrors.length > 0) {
      throw new Error(`invalid delivery contract: ${contractErrors.join('; ')}`);
    }

    for (const task of graph.tasks) {
      if (!['PENDING', 'READY'].includes(task.status) || task.attempt !== 0 || task.origin !== 'initial_plan' || task.code_snapshot_id !== undefined || task.repairs_task_id !== undefined || task.workspace_path !== undefined || task.seed_worktree !== undefined || task.failure_context !== undefined) {
        throw new Error(`initial plan cannot import runtime or completion state: ${task.id}`);
      }
    }
    if ((graph.requirements ?? []).some(requirement => requirement.status !== 'PENDING')) {
      throw new Error('initial requirements must be PENDING; completion requires independent evidence');
    }

    const spec = await readFile(join(preparedDirectory, 'spec.md'), 'utf8');
    const now = new Date().toISOString();
    const state: RunState = {
      state_schema_version: 1,
      run_id: runId,
      status: 'PLANNING',
      repo_root: inspection.canonical_root,
      baseline_commit: inspection.baseline_commit,
      created_at: now,
      updated_at: now,
      config,
      graph,
      current_task_ids: [],
      pause_requested: false,
      pending_decision_ids: [],
    };
    const store = await StateStore.open(inspection.canonical_root);
    await store.createRun(state);
    await store.writeArtifact(runId, 'spec.md', spec);
    await store.writeArtifact(
      runId,
      'requirements.json',
      `${JSON.stringify(graph.requirements ?? [], null, 2)}\n`,
    );
    await store.writeArtifact(
      runId,
      'task-graph.json',
      `${JSON.stringify(graph, null, 2)}\n`,
    );
    await store.writeArtifact(
      runId,
      'resolved-config.yaml',
      stringifyYaml(config),
    );
    return state;
  }
}

export class NodeRepositoryInspector implements RepositoryInspector {
  private readonly inspector = new NodeGitInspector();

  async inspect(repoRoot: string): Promise<RepositoryInspection> {
    const context = await getRepositoryContext(repoRoot, this.inspector);
    const baselineCommit = (await this.inspector.exec(['rev-parse', 'HEAD'], context.worktree_root)).trim();
    return {
      canonical_root: context.canonical_root,
      baseline_commit: baselineCommit,
    };
  }
}
