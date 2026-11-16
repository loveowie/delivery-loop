import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { DeliveryToolService } from '../../src/mcp/tools.js';

test('MCP server exposes delivery tools over a connected transport', async () => {
  const state = {
    state_schema_version: 1 as const,
    run_id: 'run-1',
    status: 'RUNNING' as const,
    repo_root: '/repo',
    created_at: '2026-10-28T00:00:00Z',
    updated_at: '2026-10-28T00:00:00Z',
    config: {
      profile: 'portable' as const,
      git: { mode: 'prepare-only' as const },
    },
    graph: { run_id: 'run-1', tasks: [] },
    current_task_ids: [],
    pause_requested: false,
    pending_decision_ids: [],
  };
  const handle = {
    state,
    repoRoot: '/repo',
    controller: {
      async pause() { return state; },
      async resume() { return state; },
      async cancel() { return state; },
      async respond() { return state; },
    },
    store: {
      async readRun() { return state; },
      async readEvents() { return []; },
    },
  };
  const service = new DeliveryToolService(
    {
      async start() { return handle; },
      async get() { return handle; },
    } as never,
    async () => {},
  );
  const server = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'delivery-loop-test', version: '1.0.0' });
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'delivery_start'));
  assert.ok(listed.tools.some((tool) => tool.name === 'delivery_finalize'));

  const status = await client.callTool({
    name: 'delivery_status',
    arguments: { run_id: 'run-1' },
  });
  assert.equal(status.isError, undefined);
  assert.match(JSON.stringify(status.structuredContent), /RUNNING/);

  await client.close();
  await server.close();
});
