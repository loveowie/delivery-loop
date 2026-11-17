export type ProfileName = 'portable' | 'openspec';
export type SpecProviderName = 'native' | 'openspec' | 'custom';
export type GitMode = 'prepare-only' | 'commit' | 'branch' | 'push' | 'merge';

export interface SpecConfig {
  provider: SpecProviderName;
  minimum_cli_version?: string;
  directory?: string;
}

export interface CapabilityConfig {
  profiles_file: string;
  role_skills_file: string;
  fail_on_missing_required: boolean;
  project_skills: string[];
}

export interface RuntimeConfig {
  max_parallel_workers: number;
  default_worker_timeout_seconds: number;
  worker_termination_grace_seconds: number;
  max_task_attempts: number;
  no_progress_cycles: number;
  max_dynamic_tasks: number;
  max_dynamic_depth: number;
  max_duration_hours: number;
  max_total_tokens: number;
  repository: {
    max_active_write_runs: number;
  };
}

export interface WorkerProfiles {
  default_profile: string;
  planner_profile: string;
  implementer_profile: string;
  debugger_profile: string;
  reviewer_profile: string;
  acceptance_profile: string;
}

export interface VerificationExecution {
  backend: 'container' | 'trusted-host';
  image?: string;
  command?: string;
}

export interface VerificationConfig {
  execution?: VerificationExecution;
  baseline: boolean;
  commands: {
    build: string[];
    test: string[];
    lint: string[];
    e2e: string[];
  };
}

export interface ReviewConfig {
  blocking_severities: Array<'P0' | 'P1' | 'P2' | 'P3'>;
  task_review_policy: 'risk-based' | 'always' | 'batch';
  final_review: boolean;
}

export interface GitConfig {
  mode: GitMode;
  worktree_isolation: boolean;
  delete_worktree_on_success: boolean;
  final_artifact: string;
}

export interface NotificationConfig {
  mode: 'status-only';
}

export interface DeliveryConfig {
  version: number;
  profile: ProfileName;
  spec: SpecConfig;
  capabilities: CapabilityConfig;
  runtime: RuntimeConfig;
  workers: WorkerProfiles;
  verification: VerificationConfig;
  review: ReviewConfig;
  git: GitConfig;
  notifications: NotificationConfig;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export type RunStatus =
  | 'DRAFT'
  | 'SPEC_READY'
  | 'QUEUED'
  | 'PLANNING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'WAITING_HUMAN'
  | 'BLOCKED'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED';

export type TaskStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'INTEGRATING'
  | 'FIX_REQUIRED'
  | 'INTERRUPTED'
  | 'DONE'
  | 'BLOCKED'
  | 'CANCELLED';

export type TaskType =
  | 'spec'
  | 'implementation'
  | 'test'
  | 'bugfix'
  | 'refactor'
  | 'integration'
  | 'verification'
  | 'documentation'
  | 'review_fix';

export type WorkerRole =
  | 'planner'
  | 'implementer'
  | 'test_author'
  | 'debugger'
  | 'reviewer'
  | 'acceptance';

export type RequiredOutput =
  | 'code'
  | 'test'
  | 'documentation'
  | 'migration'
  | 'configuration';

export interface TaskNode {
  id: string;
  type: TaskType;
  title: string;
  status: TaskStatus;
  priority: 'low' | 'normal' | 'high' | 'critical';
  risk: 'low' | 'medium' | 'high' | 'critical';
  origin:
    | 'initial_plan'
    | 'test_failure'
    | 'review_finding'
    | 'acceptance_gap'
    | 'user_change';
  depends_on: string[];
  requirement_ids: string[];
  acceptance_ids: string[];
  scope_paths: string[];
  required_outputs: RequiredOutput[];
  worker_role: WorkerRole;
  capability_profile: ProfileName;
  attempt: number;
  max_attempts: number;
  verification_commands: string[];
  review_policy: 'required' | 'risk-based' | 'batch' | 'none';
  code_snapshot_id?: string;
  last_failure_fingerprint?: string;
  repairs_task_id?: string;
  dynamic_depth?: number;
  seed_worktree?: string;
  workspace_path?: string;
  /** Files the worker changed during the latest attempt, relative to the worktree. */
  changed_files?: string[];
  /** Latest worker summary, kept for the delivery view and the run report. */
  last_summary?: string;
  failure_context?: { summary: string; evidence?: EvidenceRecord; findings?: AgentResult['findings'] };
}

export interface Requirement {
  id: string;
  description: string;
  status: 'PENDING' | 'SATISFIED' | 'BLOCKED';
  source?: string;
}

export interface AcceptanceCondition {
  id: string;
  requirement_id: string;
  description: string;
  verification:
    | {
        type: 'command' | 'test';
        command: string;
        expected_exit_code: number;
      }
    | { type: 'manual' }
    | { type: 'artifact' }
    | { type: 'review' };
  mandatory: boolean;
  risk: 'low' | 'medium' | 'high' | 'critical';
}

export interface TaskGraph {
  run_id: string;
  tasks: TaskNode[];
  requirements?: Requirement[];
  acceptance?: AcceptanceCondition[];
}

export interface RunState {
  state_schema_version: 1;
  revision?: number;
  run_id: string;
  status: RunStatus;
  repo_root: string;
  baseline_commit?: string;
  created_at: string;
  updated_at: string;
  config: DeliveryConfig;
  graph: TaskGraph;
  current_task_ids: string[];
  pause_requested: boolean;
  pending_decision_ids: string[];
  pending_decision_tasks?: Record<string, string[]>;
  integration_snapshot_id?: string;
  integration_worktree?: string;
  final_verification_snapshot_id?: string;
  baseline_verification_id?: string;
  /** Configured verification commands that already failed at the baseline. */
  baseline_failures?: string[];
  total_tokens_used?: number;
  usage_incomplete?: boolean;
  last_error?: string;
  completion_ref?: { path: string; sha256: string };
  delivery_artifact?: { path: string; sha256: string };
  decisions?: Array<{ decision_id: string; response: string; answered_at: string }>;
  decision_blockers?: DecisionBlocker[];
}

export interface ValidationResult<T = unknown> {
  ok: boolean;
  errors: string[];
  value?: T;
}

export interface DecisionBlocker {
  decision_id: string;
  type: 'requirement' | 'permission' | 'environment' | 'acceptance';
  question: string;
  options: string[];
  affected_task_ids: string[];
}

export interface AgentRequest {
  run_id: string;
  task_id: string;
  role: WorkerRole;
  capability_profile: ProfileName;
  required_skills: Array<{
    skill_id: string;
    root: string;
    entry: string;
    sha256: string;
    tree_sha256?: string;
    resources: string[];
  }>;
  objective: string;
  workdir: string;
  requirement_ids: string[];
  acceptance_ids: string[];
  scope_paths: string[];
  constraints: string[];
  verification_commands: string[];
  context_files: string[];
  timeout_seconds: number;
  context?: {
    specification: string;
    requirements: Requirement[];
    acceptance: AcceptanceCondition[];
    decisions: NonNullable<RunState['decisions']>;
    baseline?: { verification_id: string; failed_commands: string[] };
    failure?: TaskNode['failure_context'];
  };
}

export interface AgentResult {
  task_id: string;
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
  files_changed: string[];
  commands_run: Array<{
    command: string;
    exit_code: number;
    evidence_path?: string;
  }>;
  findings: Array<{
    id: string;
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    title: string;
    description: string;
    evidence: string;
  }>;
  remaining_risks: string[];
  suggested_tasks: string[];
  blockers: DecisionBlocker[];
  token_usage?: number;
}

export interface EvidenceRecord {
  id: string;
  run_id: string;
  task_id: string;
  acceptance_ids: string[];
  code_snapshot_id: string;
  command: string;
  cwd: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  stdout_path: string;
  stderr_path: string;
  baseline_id?: string;
  result: 'passed' | 'failed' | 'error';
}

export interface CodeSnapshot {
  id: string;
  created_at: string;
  baseline_commit: string;
  worktree_digest: string;
  content_manifest?: Record<string, { type: string; mode: string; digest: string }>;
  untracked_files: string[];
}
