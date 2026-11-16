import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DeliveryConfigSchema } from '../domain/schemas.js';
import type { DeepPartial, DeliveryConfig } from '../domain/types.js';

export const DEFAULT_CONFIG: DeliveryConfig = {
  version: 1,
  profile: 'portable',
  spec: {
    provider: 'native',
  },
  capabilities: {
    profiles_file: 'capabilities/profiles.yaml',
    role_skills_file: 'capabilities/role-skills.yaml',
    fail_on_missing_required: true,
    project_skills: [],
  },
  runtime: {
    daemon_mode: 'detached',
    max_parallel_workers: 2,
    default_worker_timeout_seconds: 1800,
    worker_termination_grace_seconds: 30,
    max_task_attempts: 3,
    no_progress_cycles: 3,
    max_dynamic_tasks: 100,
    max_dynamic_depth: 3,
    max_duration_hours: 8,
    max_total_tokens: 2_000_000,
    repository: {
      max_active_write_runs: 1,
    },
  },
  workers: {
    default_profile: 'delivery-default',
    planner_profile: 'delivery-planner',
    implementer_profile: 'delivery-implementer',
    debugger_profile: 'delivery-debugger',
    reviewer_profile: 'delivery-reviewer',
    acceptance_profile: 'delivery-acceptance',
  },
  verification: {
    execution: { backend: 'container' },
    baseline: true,
    commands: {
      build: [],
      test: [],
      lint: [],
      e2e: [],
    },
  },
  review: {
    blocking_severities: ['P0', 'P1', 'P2'],
    task_review_policy: 'risk-based',
    final_review: true,
  },
  git: {
    mode: 'prepare-only',
    worktree_isolation: true,
    delete_worktree_on_success: false,
    final_artifact: 'delivery.patch',
  },
  notifications: {
    mode: 'status-only',
  },
};

export function mergeDeep<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (override === undefined) {
    return structuredClone(base);
  }
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const current = result[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      result[key] = mergeDeep(current, value as DeepPartial<typeof current>);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result as T;
}

async function readRepositoryConfig(repoRoot: string): Promise<DeepPartial<DeliveryConfig>> {
  const path = join(repoRoot, 'delivery.yaml');
  try {
    await access(path, constants.R_OK);
  } catch {
    return {};
  }
  const parsed = parseYaml(await readFile(path, 'utf8')) as unknown;
  if (parsed === null || parsed === undefined) {
    return {};
  }
  return parsed as DeepPartial<DeliveryConfig>;
}

export async function loadConfig(
  repoRoot: string,
  override?: DeepPartial<DeliveryConfig>,
): Promise<DeliveryConfig> {
  const repositoryConfig = await readRepositoryConfig(repoRoot);
  const merged = mergeDeep(mergeDeep(DEFAULT_CONFIG, repositoryConfig), override);
  const validated = DeliveryConfigSchema.parse(merged);

  if (!validated.git.worktree_isolation) throw new Error('git.worktree_isolation=false is unsupported');
  if (validated.review.task_review_policy === 'batch') throw new Error('batch review policy is not implemented');
  if (validated.spec.provider === 'custom') throw new Error('custom spec provider is not implemented');
  if (!validated.capabilities.fail_on_missing_required) throw new Error('missing required skills cannot be ignored');

  if (validated.profile === 'openspec' && validated.spec.provider !== 'openspec') {
    throw new Error('openspec profile requires spec.provider=openspec');
  }

  return validated as DeliveryConfig;
}
