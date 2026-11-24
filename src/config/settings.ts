import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG, readRepositoryConfig } from './config.js';
import { durableWrite } from '../state/state-store.js';
import type { RuntimeConfig } from '../domain/types.js';

/**
 * The limits a human can change from the Delivery view without editing YAML.
 * Everything else (verification, git, review policy, capabilities) stays in
 * the approved `delivery.yaml`: those fields are part of the security and
 * verification contract, not day-to-day budgets.
 */
export const SETTINGS_RUNTIME_KEYS = [
  'max_total_tokens',
  'max_duration_hours',
  'max_task_attempts',
  'no_progress_cycles',
  'max_parallel_workers',
  'default_worker_timeout_seconds',
] as const;

export type SettingsRuntimeKey = (typeof SETTINGS_RUNTIME_KEYS)[number];

export type RuntimeLimits = Partial<Pick<RuntimeConfig, SettingsRuntimeKey>>;

export const RuntimeLimitsSchema = z.strictObject({
  max_total_tokens: z.number().int().positive().optional(),
  max_duration_hours: z.number().positive().optional(),
  max_task_attempts: z.number().int().min(1).optional(),
  no_progress_cycles: z.number().int().min(1).optional(),
  max_parallel_workers: z.number().int().min(1).optional(),
  default_worker_timeout_seconds: z.number().int().positive().optional(),
});

const SettingsFileSchema = z.strictObject({
  version: z.literal(1).optional(),
  runtime: RuntimeLimitsSchema.default({}),
});

export type SettingsScope = 'global' | 'repo';

export interface SettingsScopeView {
  scope: SettingsScope;
  path: string;
  /** False when no settings file exists for this scope. */
  exists: boolean;
  runtime: RuntimeLimits;
}

export interface RuntimeSettingsView {
  repo_root: string | null;
  global: SettingsScopeView;
  repo: SettingsScopeView;
  delivery_yaml: { path: string | null; runtime: RuntimeLimits };
  defaults: RuntimeLimits;
  /** defaults ⊕ delivery.yaml ⊕ global ⊕ repo */
  effective: RuntimeLimits;
}

export interface SettingsStoreOptions {
  /** Overrides DELIVERY_LOOP_HOME / ~/.delivery-loop for the global settings file. */
  home?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickLimits(runtime: object | undefined | null): RuntimeLimits {
  if (runtime === undefined || runtime === null) return {};
  const limits: RuntimeLimits = {};
  for (const key of SETTINGS_RUNTIME_KEYS) {
    const value = (runtime as Record<string, unknown>)[key];
    if (typeof value === 'number') limits[key] = value;
  }
  return limits;
}

/** Drops `undefined` values so the result satisfies exactOptionalPropertyTypes. */
export function normalizeRuntimeLimits(
  runtime: Partial<Record<SettingsRuntimeKey, number | undefined>> | undefined,
): RuntimeLimits {
  return pickLimits(runtime);
}

async function readSettingsFile(path: string): Promise<RuntimeLimits> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new Error(`settings file is not valid YAML/JSON: ${path}: ${errorMessage(error)}`);
  }
  const result = SettingsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid settings file ${path}: ${issues}`);
  }
  return normalizeRuntimeLimits(result.data.runtime);
}

function settingsFileContent(runtime: RuntimeLimits): string {
  return [
    '# Delivery loop settings. Written by the Delivery board; a human may edit it too.',
    '# Only runtime budgets live here. Verification and git policy stay in delivery.yaml.',
    stringifyYaml({ version: 1, runtime }),
  ].join('\n');
}

export class SettingsStore {
  readonly home: string;

  constructor(options: SettingsStoreOptions = {}) {
    this.home = options.home ?? process.env.DELIVERY_LOOP_HOME ?? join(homedir(), '.delivery-loop');
  }

  globalPath(): string {
    return join(this.home, 'settings.json');
  }

  repoPath(repoRoot: string): string {
    return join(repoRoot, '.delivery', 'settings.yaml');
  }

  async readGlobal(): Promise<RuntimeLimits> {
    return await readSettingsFile(this.globalPath());
  }

  async readRepo(repoRoot: string): Promise<RuntimeLimits> {
    return await readSettingsFile(this.repoPath(repoRoot));
  }

  /** Global defaults overridden field-by-field by repository settings. */
  async mergedRuntime(repoRoot: string | null): Promise<RuntimeLimits> {
    const global = await this.readGlobal();
    if (repoRoot === null) return global;
    const repo = await this.readRepo(repoRoot);
    return { ...global, ...repo };
  }

  async writeGlobal(runtime: RuntimeLimits): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await durableWrite(this.globalPath(), `${JSON.stringify({ version: 1, runtime }, null, 2)}\n`);
  }

  async writeRepo(repoRoot: string, runtime: RuntimeLimits): Promise<void> {
    const path = this.repoPath(repoRoot);
    await mkdir(dirname(path), { recursive: true });
    await durableWrite(path, settingsFileContent(runtime));
  }

  async reset(scope: SettingsScope, repoRoot: string | null): Promise<void> {
    if (scope === 'global') {
      await rm(this.globalPath(), { force: true });
      return;
    }
    if (repoRoot === null) throw new Error('repo_root is required for repository settings');
    await rm(this.repoPath(repoRoot), { force: true });
  }

  async describe(repoRoot: string | null): Promise<RuntimeSettingsView> {
    const defaults = pickLimits(DEFAULT_CONFIG.runtime);
    const globalPath = this.globalPath();
    const global = await this.readGlobal();
    let repoSettings: RuntimeLimits = {};
    let deliveryYaml: RuntimeLimits = {};
    let repoPath: string | null = null;
    let deliveryYamlPath: string | null = null;
    if (repoRoot !== null) {
      repoPath = this.repoPath(repoRoot);
      repoSettings = await this.readRepo(repoRoot);
      deliveryYamlPath = join(repoRoot, 'delivery.yaml');
      try {
        const repositoryConfig = await readRepositoryConfig(repoRoot);
        deliveryYaml = pickLimits(repositoryConfig.runtime);
      } catch (error) {
        throw new Error(`invalid delivery.yaml: ${errorMessage(error)}`);
      }
    }
    return {
      repo_root: repoRoot,
      global: {
        scope: 'global',
        path: globalPath,
        exists: await exists(globalPath),
        runtime: global,
      },
      repo: {
        scope: 'repo',
        path: repoPath ?? '',
        exists: repoPath !== null && await exists(repoPath),
        runtime: repoSettings,
      },
      delivery_yaml: { path: deliveryYamlPath, runtime: deliveryYaml },
      defaults,
      effective: { ...defaults, ...deliveryYaml, ...global, ...repoSettings },
    };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
