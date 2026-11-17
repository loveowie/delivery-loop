import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package manifest declares a DSH bundle and no legacy surface', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    main?: string;
    exports?: Record<string, string>;
    files?: string[];
    dependencies?: Record<string, string>;
    dsh?: { bundle?: { patch?: string }; client?: { platform?: string } };
  };

  assert.equal(manifest.main, 'dist/dsh/host.js');
  assert.equal(manifest.exports?.['.'], './dist/dsh/host.js');
  assert.equal(manifest.exports?.['./client'], './client.js');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.equal(manifest.dependencies?.['@modelcontextprotocol/sdk'], undefined);
  for (const forbidden of ['.codex-plugin', '.mcp.json']) {
    assert.equal(manifest.files?.includes(forbidden), false, `${forbidden} must not be packaged`);
  }
  for (const required of ['dist', 'client.js', 'cordis.patch.yml', 'locale', 'icon.svg', 'schemas', 'skills']) {
    assert.equal(manifest.files?.includes(required), true, `${required} must be packaged`);
  }
});
