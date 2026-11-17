import type { RunState } from '../domain/types.js';
import { finalizeRun } from '../finalize/finalizer.js';
import type {
  FinalizeAction,
  FinalizeExecutionContext,
  FinalizeExecutionResult,
  FinalizeInput,
} from '../finalize/finalizer.js';
import { writeDeliveryReport } from '../reporting/report-writer.js';
import { EvidenceLedger } from '../state/evidence-ledger.js';
import type {
  DeliveryRunManagerPort,
  RuntimeHandle,
  StartRunInput,
} from '../runtime/types.js';

export interface StatusInput {
  run_id: string;
  repo_root?: string | undefined;
}

export interface WatchInput extends StatusInput {
  timeout_ms?: number | undefined;
}

export interface DecisionInput {
  run_id: string;
  decision_id: string;
  response: string;
  repo_root?: string | undefined;
}

export interface RunActionInput {
  run_id: string;
  repo_root?: string | undefined;
}

export interface ResumeInput extends RunActionInput {
  max_total_tokens?: number | undefined;
  max_duration_hours?: number | undefined;
  max_task_attempts?: number | undefined;
}

export interface ExportReportInput extends RunActionInput {
  repo_root: string;
}

export interface FinalizeToolInput extends RunActionInput, FinalizeInput {
  repo_root?: string | undefined;
}

export type FinalizeExecutor = (
  action: FinalizeAction,
  handle: RuntimeHandle,
  context: FinalizeExecutionContext,
) => Promise<FinalizeExecutionResult>;

function countTasks(state: RunState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of state.graph.tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

function stateStatus(state: RunState) {
  return {
    run_id: state.run_id,
    status: state.status,
    repo_root: state.repo_root,
    task_counts: countTasks(state),
    current_task_ids: state.current_task_ids,
    pending_decision_ids: state.pending_decision_ids,
    integration_snapshot_id: state.integration_snapshot_id ?? null,
    git_mode: state.config.git.mode,
    last_error: state.last_error ?? null,
    decision_blockers: state.decision_blockers ?? [],
    total_tokens_used: state.total_tokens_used ?? 0,
    usage_incomplete: state.usage_incomplete ?? false,
    revision: state.revision ?? 0,
    completion_ref: state.completion_ref ?? null,
  };
}

export class DeliveryService {
  private readonly manager: DeliveryRunManagerPort;
  private readonly finalizeExecutor: FinalizeExecutor;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    manager: DeliveryRunManagerPort,
    finalizeExecutor: FinalizeExecutor,
    sleep: (milliseconds: number) => Promise<void> = async (milliseconds) =>
      await new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.manager = manager;
    this.finalizeExecutor = finalizeExecutor;
    this.sleep = sleep;
  }

  async delivery_start(input: StartRunInput) {
    const handle = await this.manager.start(input);
    return stateStatus(handle.state);
  }

  async delivery_status(input: StatusInput) {
    const handle = this.manager.read === undefined
      ? await this.manager.get(input.run_id, input.repo_root)
      : await this.manager.read(input.run_id, input.repo_root);
    const state = (await handle.store.readRun(input.run_id)) ?? handle.state;
    const events = await handle.store.readEvents(input.run_id, 10);
    return {
      ...stateStatus(state),
      recent_events: events,
    };
  }

  async delivery_watch(input: WatchInput) {
    const deadline = Date.now() + Math.max(1, Math.min(input.timeout_ms ?? 30_000, 300_000));
    while (true) {
      const status = await this.delivery_status(input);
      if (['WAITING_HUMAN', 'BLOCKED', 'PAUSED', 'COMPLETED', 'CANCELLED'].includes(status.status)) {
        return status;
      }
      if (Date.now() >= deadline) {
        return status;
      }
      await this.sleep(500);
    }
  }

  async delivery_respond(input: DecisionInput) {
    const handle = await this.manager.get(input.run_id, input.repo_root);
    const state = await handle.controller.respond(input.run_id, input.decision_id, input.response);
    handle.state = state;
    await this.manager.wake?.(handle);
    return stateStatus(state);
  }

  async delivery_pause(input: RunActionInput) {
    const handle = await this.manager.get(input.run_id, input.repo_root);
    return stateStatus(await handle.controller.pause(input.run_id));
  }

  async delivery_resume(input: ResumeInput) {
    const handle = await this.manager.get(input.run_id, input.repo_root);
    const state = await handle.controller.resume(input.run_id, {
      ...(typeof input.max_total_tokens === 'number' ? { max_total_tokens: input.max_total_tokens } : {}),
      ...(typeof input.max_duration_hours === 'number' ? { max_duration_hours: input.max_duration_hours } : {}),
      ...(typeof input.max_task_attempts === 'number' ? { max_task_attempts: input.max_task_attempts } : {}),
    });
    handle.state = state;
    await this.manager.wake?.(handle);
    return stateStatus(state);
  }

  async delivery_cancel(input: RunActionInput) {
    const handle = await this.manager.get(input.run_id, input.repo_root);
    handle.state = await handle.controller.cancel(input.run_id);
    await this.manager.wake?.(handle);
    return stateStatus(handle.state);
  }

  async delivery_export_report(input: ExportReportInput) {
    const handle = this.manager.read === undefined
      ? await this.manager.get(input.run_id, input.repo_root)
      : await this.manager.read(input.run_id, input.repo_root);
    const state = await handle.store.readRun(input.run_id);
    if (state === undefined) {
      throw new Error(`run not found: ${input.run_id}`);
    }
    const evidence = await new EvidenceLedger(handle.repoRoot).readAll(input.run_id);
    const path = await writeDeliveryReport(handle.repoRoot, state, evidence);
    return { run_id: input.run_id, report_path: path };
  }

  async delivery_finalize(input: FinalizeToolInput) {
    const handle = await this.manager.get(input.run_id, input.repo_root);
    return await finalizeRun(
      handle.store,
      input.run_id,
      { mode: input.mode, confirmation: input.confirmation },
      async (action, _state, context) => this.finalizeExecutor(action, handle, context),
    );
  }
}
