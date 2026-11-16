import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../../src/runtime/preflight.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';

test('portable preflight checks codex but does not require openspec', async () => {
  const probed: string[] = [];
  await runPreflight(
    { ...structuredClone(DEFAULT_CONFIG), capabilities: { ...DEFAULT_CONFIG.capabilities, project_skills: [] } },
    {
      async version(command) {
        probed.push(command);
        return command === 'codex' ? 'codex-cli 0.164.0' : undefined;
      },
    },
    {
      async resolve(_profile, role) {
        return [{ skill_id: role, root: '/tmp', entry: 'SKILL.md', sha256: 'x', resources: [] }];
      },
      async verifyAll() {},
    },
  );

  assert.deepEqual(probed, ['codex']);
});

test('openspec preflight rejects a CLI below the configured minimum', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.profile = 'openspec';
  config.spec = { provider: 'openspec', minimum_cli_version: '1.7.0' };

  await assert.rejects(
    runPreflight(
      config,
      {
        async version(command) {
          return command === 'codex' ? 'codex-cli 0.164.0' : '1.6.0';
        },
      },
      { async resolve() { return []; }, async verifyAll() {} },
    ),
    /openspec.*1\.7\.0/i,
  );
});
