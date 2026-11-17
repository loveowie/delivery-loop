import { z } from 'zod';
import type { TaskGraph, ValidationResult } from './types.js';

const ReviewSeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);

const DeliveryConfigSchemaInternal = z.object({
  version: z.number().int().positive(),
  profile: z.enum(['portable', 'openspec']),
  spec: z.object({
    provider: z.enum(['native', 'openspec', 'custom']),
    minimum_cli_version: z.string().optional(),
    directory: z.string().optional(),
  }),
  capabilities: z.object({
    profiles_file: z.string().min(1),
    role_skills_file: z.string().min(1),
    fail_on_missing_required: z.boolean(),
    project_skills: z.array(z.string()),
  }),
  runtime: z.object({
    daemon_mode: z.enum(['detached', 'foreground']),
    max_parallel_workers: z.number().int().min(1),
    default_worker_timeout_seconds: z.number().int().positive(),
    worker_termination_grace_seconds: z.number().int().nonnegative(),
    max_task_attempts: z.number().int().min(1),
    no_progress_cycles: z.number().int().min(1),
    max_dynamic_tasks: z.number().int().nonnegative(),
    max_dynamic_depth: z.number().int().nonnegative(),
    max_duration_hours: z.number().positive(),
    max_total_tokens: z.number().int().positive(),
    repository: z.object({
      max_active_write_runs: z.number().int().min(1),
    }),
  }),
  workers: z.object({
    default_profile: z.string().min(1),
    planner_profile: z.string().min(1),
    implementer_profile: z.string().min(1),
    debugger_profile: z.string().min(1),
    reviewer_profile: z.string().min(1),
    acceptance_profile: z.string().min(1),
  }),
  verification: z.object({
    execution: z.object({
      backend: z.enum(['container', 'trusted-host']),
      image: z.string().optional(), command: z.string().optional(),
    }).optional(),
    baseline: z.boolean(),
    commands: z.object({
      build: z.array(z.string()),
      test: z.array(z.string()),
      lint: z.array(z.string()),
      e2e: z.array(z.string()),
    }),
  }),
  review: z.object({
    blocking_severities: z.array(ReviewSeveritySchema),
    task_review_policy: z.enum(['risk-based', 'always', 'batch']),
    final_review: z.boolean(),
  }),
  git: z.object({
    mode: z.enum(['prepare-only', 'commit', 'branch', 'push', 'merge']),
    worktree_isolation: z.boolean(),
    delete_worktree_on_success: z.boolean(),
    final_artifact: z.string().min(1),
  }),
  notifications: z.object({
    mode: z.literal('status-only'),
  }),
});

export const DeliveryConfigSchema = DeliveryConfigSchemaInternal;

export const TaskStatusSchema = z.enum([
  'PENDING',
  'READY',
  'RUNNING',
  'VERIFYING',
  'REVIEWING',
  'INTEGRATING',
  'FIX_REQUIRED',
  'INTERRUPTED',
  'DONE',
  'BLOCKED',
  'CANCELLED',
]);

export const TaskNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'spec',
    'implementation',
    'test',
    'bugfix',
    'refactor',
    'integration',
    'verification',
    'documentation',
    'review_fix',
  ]),
  title: z.string().min(1),
  status: TaskStatusSchema,
  priority: z.enum(['low', 'normal', 'high', 'critical']),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  origin: z.enum([
    'initial_plan',
    'test_failure',
    'review_finding',
    'acceptance_gap',
    'user_change',
  ]),
  depends_on: z.array(z.string()),
  requirement_ids: z.array(z.string()),
  acceptance_ids: z.array(z.string()),
  scope_paths: z.array(z.string()),
  required_outputs: z.array(
    z.enum(['code', 'test', 'documentation', 'migration', 'configuration']),
  ),
  worker_role: z.enum([
    'planner',
    'implementer',
    'test_author',
    'debugger',
    'reviewer',
    'acceptance',
  ]),
  capability_profile: z.enum(['portable', 'openspec']),
  attempt: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  verification_commands: z.array(z.string()),
  review_policy: z.enum(['required', 'risk-based', 'batch', 'none']),
  code_snapshot_id: z.string().optional(),
  last_failure_fingerprint: z.string().optional(),
  repairs_task_id: z.string().optional(),
  dynamic_depth: z.number().int().nonnegative().optional(),
  seed_worktree: z.string().optional(),
  workspace_path: z.string().optional(),
  changed_files: z.array(z.string()).optional(),
  last_summary: z.string().optional(),
  failure_context: z.object({ summary: z.string(), evidence: z.unknown().optional(), findings: z.array(z.unknown()).optional() }).optional(),
});

export const TaskGraphSchema = z.object({
  run_id: z.string().min(1),
  tasks: z.array(TaskNodeSchema),
  requirements: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1),
        status: z.enum(['PENDING', 'SATISFIED', 'BLOCKED']),
        source: z.string().optional(),
      }),
    )
    .optional(),
  acceptance: z
    .array(
      z.object({
        id: z.string().min(1),
        requirement_id: z.string().min(1),
        description: z.string().min(1),
        verification: z.discriminatedUnion('type', [
          z.object({
            type: z.enum(['command', 'test']),
            command: z.string().min(1),
            expected_exit_code: z.number().int(),
          }),
          z.object({
            type: z.enum(['manual', 'artifact', 'review']),
          }),
        ]),
        mandatory: z.boolean(),
        risk: z.enum(['low', 'medium', 'high', 'critical']),
      }),
    )
    .optional(),
});

export const RunStateSchema = z.object({
  state_schema_version: z.literal(1),
  revision: z.number().int().nonnegative().optional(),
  run_id: z.string().min(1),
  status: z.enum(['DRAFT','SPEC_READY','QUEUED','PLANNING','RUNNING','VERIFYING','WAITING_HUMAN','BLOCKED','PAUSED','COMPLETED','CANCELLED']),
  repo_root: z.string().min(1),
  baseline_commit: z.string().optional(),
  created_at: z.string(), updated_at: z.string(),
  config: DeliveryConfigSchema,
  graph: TaskGraphSchema,
  current_task_ids: z.array(z.string()),
  pause_requested: z.boolean(),
  pending_decision_ids: z.array(z.string()),
  pending_decision_tasks: z.record(z.string(), z.array(z.string())).optional(),
  integration_snapshot_id: z.string().optional(), integration_worktree: z.string().optional(),
  final_verification_snapshot_id: z.string().optional(), baseline_verification_id: z.string().optional(),
  total_tokens_used: z.number().int().nonnegative().optional(),
  usage_incomplete: z.boolean().optional(), last_error: z.string().optional(),
  decisions: z.array(z.object({decision_id:z.string(),response:z.string(),answered_at:z.string()})).optional(),
  decision_blockers: z.array(z.object({decision_id:z.string(),type:z.enum(['requirement','permission','environment','acceptance']),question:z.string(),options:z.array(z.string()),affected_task_ids:z.array(z.string())})).optional(),
  completion_ref: z.object({path:z.string(),sha256:z.string()}).optional(),
  delivery_artifact: z.object({path:z.string(),sha256:z.string()}).optional(),
}).passthrough();

export const AgentRequestSchema = z.object({
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  role: z.enum([
    'planner',
    'implementer',
    'test_author',
    'debugger',
    'reviewer',
    'acceptance',
  ]),
  capability_profile: z.enum(['portable', 'openspec']),
  required_skills: z.array(
    z.object({
      skill_id: z.string(),
      root: z.string(),
      entry: z.string(),
      sha256: z.string(),
      tree_sha256: z.string().optional(),
      resources: z.array(z.string()),
    }),
  ),
  objective: z.string().min(1),
  workdir: z.string().min(1),
  requirement_ids: z.array(z.string()),
  acceptance_ids: z.array(z.string()),
  scope_paths: z.array(z.string()),
  constraints: z.array(z.string()),
  verification_commands: z.array(z.string()),
  context_files: z.array(z.string()),
  timeout_seconds: z.number().int().positive(),
  context: z.object({
    specification: z.string(),
    requirements: z.array(z.unknown()),
    acceptance: z.array(z.unknown()),
    decisions: z.array(z.object({ decision_id: z.string(), response: z.string(), answered_at: z.string() })),
    failure: z.unknown().optional(),
  }).optional(),
});

export const AgentResultSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['completed', 'blocked', 'failed']),
  summary: z.string(),
  files_changed: z.array(z.string()),
  commands_run: z.array(
    z.object({
      command: z.string(),
      exit_code: z.number().int(),
      evidence_path: z.string().optional(),
    }),
  ),
  findings: z.array(
    z.object({
      id: z.string(),
      severity: ReviewSeveritySchema,
      title: z.string(),
      description: z.string(),
      evidence: z.string(),
    }),
  ),
  remaining_risks: z.array(z.string()),
  suggested_tasks: z.array(z.string()),
  blockers: z.array(
    z.object({
      decision_id: z.string(),
      type: z.enum(['requirement', 'permission', 'environment', 'acceptance']),
      question: z.string(),
      options: z.array(z.string()),
      affected_task_ids: z.array(z.string()),
    }),
  ),
  token_usage: z.number().int().nonnegative().optional(),
});

export function validateTaskGraph(graph: TaskGraph): ValidationResult<TaskGraph> {
  const parsed = TaskGraphSchema.safeParse(graph);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
    };
  }

  const candidate = parsed.data as TaskGraph;
  const errors: string[] = [];
  const ids = new Map<string, TaskGraph['tasks'][number]>();
  const requirementIds = new Set<string>();
  const acceptanceIds = new Set<string>();

  for (const task of candidate.tasks) {
    if (ids.has(task.id)) {
      errors.push(`duplicate task id: ${task.id}`);
    }
    ids.set(task.id, task);
  }

  for (const requirement of candidate.requirements ?? []) {
    if (requirementIds.has(requirement.id)) {
      errors.push(`duplicate requirement id: ${requirement.id}`);
    }
    requirementIds.add(requirement.id);
  }
  for (const condition of candidate.acceptance ?? []) {
    if (acceptanceIds.has(condition.id)) {
      errors.push(`duplicate acceptance id: ${condition.id}`);
    }
    acceptanceIds.add(condition.id);
    if (candidate.requirements !== undefined && !requirementIds.has(condition.requirement_id)) {
      errors.push(`acceptance ${condition.id} has unknown requirement: ${condition.requirement_id}`);
    }
  }

  for (const task of candidate.tasks) {
    for (const dependency of task.depends_on) {
      if (!ids.has(dependency)) {
        errors.push(`task ${task.id} has unknown dependency: ${dependency}`);
      }
    }
    for (const requirementId of task.requirement_ids) {
      if (candidate.requirements !== undefined && !requirementIds.has(requirementId)) {
        errors.push(`task ${task.id} has unknown requirement: ${requirementId}`);
      }
    }
    for (const acceptanceId of task.acceptance_ids) {
      if (candidate.acceptance !== undefined && !acceptanceIds.has(acceptanceId)) {
        errors.push(`task ${task.id} has unknown acceptance: ${acceptanceId}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      errors.push(`task graph contains a cycle: ${[...path, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id) || !ids.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of ids.get(id)?.depends_on ?? []) {
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of candidate.tasks) {
    visit(task.id, []);
  }

  return errors.length === 0
    ? { ok: true, errors: [], value: candidate }
    : { ok: false, errors };
}
