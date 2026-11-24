import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RuntimeLimitsSchema, SettingsStore, normalizeRuntimeLimits } from '../config/settings.js';
import type { RuntimeSettingsView, SettingsScope } from '../config/settings.js';

export interface SaveSettingsInput {
  scope: SettingsScope;
  repo_root?: string | undefined;
  /** Missing or empty means "clear this scope's overrides". */
  runtime?: unknown;
  reset?: boolean | undefined;
}

export interface SettingsServiceOptions {
  store?: SettingsStore | undefined;
}

async function canonicalRepository(path: string): Promise<string> {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new Error('repo_root is required');
  }
  const resolved = resolve(path);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    throw new Error(`repository not found: ${path}`);
  }
  const info = await stat(real).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new Error(`repository is not a directory: ${path}`);
  }
  return real;
}

function validationMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/**
 * Read and write the runtime budgets a human changes from the Delivery view.
 * The API accepts only the whitelisted runtime keys; verification, git and
 * review policy cannot be changed here.
 */
export class SettingsService {
  private readonly store: SettingsStore;

  constructor(options: SettingsServiceOptions = {}) {
    this.store = options.store ?? new SettingsStore();
  }

  async get(repoRoot?: string | undefined): Promise<RuntimeSettingsView> {
    const root = typeof repoRoot === 'string' && repoRoot.trim().length > 0
      ? await canonicalRepository(repoRoot)
      : null;
    return await this.store.describe(root);
  }

  async save(input: SaveSettingsInput): Promise<RuntimeSettingsView> {
    if (input.scope !== 'global' && input.scope !== 'repo') {
      throw new Error('scope must be "global" or "repo"');
    }
    const repoRoot = typeof input.repo_root === 'string' && input.repo_root.trim().length > 0
      ? await canonicalRepository(input.repo_root)
      : null;
    if (input.scope === 'repo' && repoRoot === null) {
      throw new Error('repo_root is required for repository settings');
    }

    const parsed = RuntimeLimitsSchema.safeParse(input.runtime ?? {});
    if (!parsed.success) {
      throw new Error(`invalid runtime limits: ${validationMessage(parsed.error)}`);
    }
    const runtime = normalizeRuntimeLimits(parsed.data);
    if (input.reset === true || Object.keys(runtime).length === 0) {
      await this.store.reset(input.scope, repoRoot);
    } else if (input.scope === 'global') {
      await this.store.writeGlobal(runtime);
    } else {
      await this.store.writeRepo(repoRoot as string, runtime);
    }
    return await this.store.describe(repoRoot);
  }
}
