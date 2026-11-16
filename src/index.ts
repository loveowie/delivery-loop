#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DeliveryToolService } from './mcp/tools.js';
import { createMcpServer } from './mcp/server.js';
import { DeliveryRunManager } from './runtime/run-manager.js';
import { RuntimeFactory } from './runtime/runtime-factory.js';
import { launchDetachedWorker } from './runtime/detached-worker.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(sourceDirectory, '..');
const manager = new DeliveryRunManager({
  pluginRoot,
  runtimeFactory: new RuntimeFactory({ pluginRoot }),
  workerLauncher: launchDetachedWorker,
});
const service = new DeliveryToolService(manager, async (action, handle, context) => {
  return await manager.executeFinalize(action, handle, context);
});
const server = createMcpServer(service);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('delivery-loop MCP server running on stdio');
