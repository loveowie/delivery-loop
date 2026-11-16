import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = resolve(process.argv[2]);
const home = resolve(process.argv[3]);
const transport = new StdioClientTransport({
  command: '/bin/sh',
  args: [resolve(packageRoot, 'scripts/launch_delivery_mcp')],
  cwd: home,
  env: { PATH: process.env.PATH, HOME: home },
});
const client = new Client({ name: 'delivery-release-check', version: '1.0.0' });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'delivery_start', 'delivery_status', 'delivery_watch', 'delivery_respond',
    'delivery_pause', 'delivery_resume', 'delivery_cancel',
    'delivery_export_report', 'delivery_finalize',
  ].sort());
  process.stdout.write('Independent production install and stdio MCP handshake: 9 tools verified\n');
} finally {
  await client.close();
}
