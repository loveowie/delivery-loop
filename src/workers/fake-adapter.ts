import type { AgentRequest, AgentResult } from '../domain/types.js';
import type { WorkerAdapter } from './worker-adapter.js';

export class FakeWorkerAdapter implements WorkerAdapter {
  readonly requests: AgentRequest[] = [];

  constructor(private readonly result: AgentResult | (() => Promise<AgentResult>)) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.requests.push(structuredClone(request));
    return typeof this.result === 'function' ? await this.result() : structuredClone(this.result);
  }
}
