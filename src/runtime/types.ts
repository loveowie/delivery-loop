import type { DeliveryController } from '../controller/delivery-controller.js';
import type { DeliveryConfig, DeepPartial, RunState } from '../domain/types.js';
import type { EvidenceLedger } from '../state/evidence-ledger.js';
import type { StateStore } from '../state/state-store.js';

export interface StartRunInput {
  repo_root: string;
  prepared_directory: string;
  run_id?: string | undefined;
  config_override?: DeepPartial<DeliveryConfig> | undefined;
  /** Explicit user confirmation for host-shell verification. */
  allow_trusted_host?: boolean | undefined;
}

export interface RuntimeHandle {
  state: RunState;
  store: StateStore;
  repoRoot: string;
  controller: DeliveryController;
  evidenceLedger?: EvidenceLedger;
}

export interface ReadonlyRuntimeHandle {
  state: RunState;
  store: StateStore;
  repoRoot: string;
}

export interface DeliveryRunManagerPort {
  start(input: StartRunInput): Promise<RuntimeHandle>;
  get(runId: string, repoRoot?: string): Promise<RuntimeHandle>;
  read?(runId: string, repoRoot?: string): Promise<ReadonlyRuntimeHandle>;
  wake?(handle: RuntimeHandle): Promise<void>;
  waitForExecutionExit?(runId: string): Promise<void>;
}
