import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ParentFallback } from '../../src/dsh/host.js';
import { DshSubagentWorkerAdapter } from '../../src/workers/dsh-subagent-adapter.js';
import type { DshAgent, DshSubagentServices } from '../../src/workers/dsh-subagent-adapter.js';
import type { AgentRequest } from '../../src/domain/types.js';

const schemaPath = join(process.cwd(), 'schemas', 'agent-result.schema.json');

interface FakeAgent extends DshAgent {
  ctx: { fiber: { uid: string | null }; on?: never };
}

function agent(id: string, fiberUid: string | null): FakeAgent {
  return { id, ctx: { fiber: { uid: fiberUid } } };
}

function fakeAgents(initial: DshAgent[]) {
  const registry = new Map(initial.map((entry) => [entry.id, entry]));
  const created: Array<{ sessionId: string; agent: DshAgent; dispose(): Promise<void> }> = [];
  const service = {
    get(id: string) {
      return registry.get(id);
    },
    list() {
      return [...registry.values()];
    },
    async create(spec: { sessionId: string; meta: { cwd: string } }) {
      const createdAgent = agent(`coordinator-${created.length + 1}`, 'coordinator-fiber');
      const handle = {
        sessionId: spec.sessionId,
        agent: createdAgent as DshAgent,
        async dispose() {
          registry.delete(createdAgent.id);
        },
      };
      registry.set(createdAgent.id, createdAgent);
      created.push(handle);
      return handle;
    },
  };
  return { service, registry, created };
}

function fallbackFor(
  service: ReturnType<typeof fakeAgents>['service'],
  preferredAgent: () => DshAgent | undefined,
): ParentFallback {
  return new ParentFallback({
    agents: service,
    preferredAgent,
    newSessionId: () => 'delivery-coordinator-session',
    cwd: () => '/tmp',
  });
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    run_id: 'R-1',
    task_id: 'TASK-1',
    role: 'implementer',
    capability_profile: 'portable',
    required_skills: [],
    objective: 'Add a greeting',
    workdir: '/tmp/worktree',
    requirement_ids: ['REQ-1'],
    acceptance_ids: ['ACC-1'],
    scope_paths: ['src/'],
    constraints: [],
    verification_commands: ['npm test'],
    context_files: [],
    timeout_seconds: 30,
    ...overrides,
  };
}

test('fallback skips an Agent whose fiber was disposed', async () => {
  const disposed = agent('disposed-worker', null);
  const active = agent('active-agent', 'fiber-active');
  const { service } = fakeAgents([disposed, active]);
  const fallback = fallbackFor(service, () => undefined);

  assert.equal(await fallback.fallbackParent(), active);
});

test('fallback prefers the current initiating tool-call Agent', async () => {
  const listed = agent('listed-active', 'fiber-listed');
  const initiating = agent('initiating-active', 'fiber-initiating');
  const { service } = fakeAgents([listed, initiating]);
  const fallback = fallbackFor(service, () => initiating);

  assert.equal(await fallback.fallbackParent(), initiating);
});

test('fallback ignores a disposed initiating Agent and uses a live listed Agent', async () => {
  const initiating = agent('initiating-disposed', null);
  const listed = agent('listed-active', 'fiber-listed');
  const { service } = fakeAgents([initiating, listed]);
  const fallback = fallbackFor(service, () => initiating);

  assert.equal(await fallback.fallbackParent(), listed);
});

test('fallback creates a coordinator only when no Agent is usable', async () => {
  const { service, created } = fakeAgents([agent('disposed-worker', null)]);
  const fallback = fallbackFor(service, () => undefined);

  const parent = await fallback.fallbackParent();

  assert.equal(created.length, 1);
  assert.match(created[0]?.sessionId ?? '', /delivery-coordinator/);
  assert.equal(parent, created[0]?.agent);
});

test('an active coordinator is reused but a disposed coordinator is rebuilt', async () => {
  const { service, created } = fakeAgents([]);
  const fallback = fallbackFor(service, () => undefined);

  const first = await fallback.fallbackParent();
  assert.equal(created.length, 1);
  assert.equal(await fallback.fallbackParent(), first);
  assert.equal(created.length, 1);

  // Cordis marks a disposed Agent's fiber uid as null.
  (first as FakeAgent).ctx.fiber.uid = null;

  const rebuilt = await fallback.fallbackParent();

  assert.notEqual(rebuilt, first);
  assert.equal(created.length, 2);
  assert.equal(rebuilt, created[1]?.agent);
});

test('the worker adapter falls back when the remembered parent was disposed', async () => {
  const disposed = agent('parent-disposed', null);
  const fallbackAgent = agent('fallback-live', 'fiber-live');
  let capturedParent: unknown;
  const host: DshSubagentServices = {
    agents: {
      get: (id) => {
        if (id === disposed.id) return disposed;
        if (id === fallbackAgent.id) return fallbackAgent;
        return undefined;
      },
      list: () => [disposed, fallbackAgent],
    },
    subagents: {
      getProvider: () => ({}),
      async startActivation(spec) {
        capturedParent = spec.parent;
        return {
          childId: String(spec.childId),
          result: Promise.resolve({
            output: [],
            structured: {
              task_id: 'TASK-1',
              status: 'completed',
              summary: 'done',
              files_changed: [],
              commands_run: [],
              findings: [],
              remaining_risks: [],
              suggested_tasks: [],
              blockers: [],
            },
            stopReason: 'completed',
          }),
          dispose: async () => {},
        };
      },
    },
  };
  const adapter = new DshSubagentWorkerAdapter({
    host,
    schemaPath,
    resolveParent: () => disposed,
    fallbackParent: async () => fallbackAgent,
  });

  const value = await adapter.run(request(), {});

  assert.equal(value.status, 'completed');
  assert.equal(capturedParent, fallbackAgent);
});
