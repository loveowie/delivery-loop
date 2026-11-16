import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('plugin manifest exposes skills and MCP server', async () => {
  const manifest = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8')) as {
    name: string;
    skills: string;
    mcpServers: string;
  };
  assert.equal(manifest.name, 'delivery-loop');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
});
