import type { AgentRequest, AgentResult } from '../domain/types.js';

export interface WorkerRunOptions {
  profile?: string;
  signal?: AbortSignal;
}

export interface WorkerAdapter {
  run(request: AgentRequest, options?: WorkerRunOptions): Promise<AgentResult>;
}
