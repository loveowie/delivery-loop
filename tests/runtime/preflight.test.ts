import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../../src/runtime/preflight.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';

test('portable preflight verifies skills without probing external CLIs', async () => {
  const probed: string[] = [];
  let verified = 0;
  await runPreflight(
    { ...structuredClone(DEFAULT_CONFIG), capabilities: { ...DEFAULT_CONFIG.capabilities, project_skills: [] } },
    {
      async version(command) {
        probed.push(command);
        return undefined;
      },
    },
    {
      async resolve(_profile, role) {
        return [{ skill_id: role, root: '/tmp', entry: 'SKILL.md', sha256: 'x', resources: [] }];
      },
      async verifyAll() { verified += 1; },
    },
  );

  assert.deepEqual(probed, []);
  assert.equal(verified, 6);
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
          return command === 'openspec' ? '1.6.0' : undefined;
        },
      },
      { async resolve() { return []; }, async verifyAll() {} },
    ),
    /openspec.*1\.7\.0/i,
  );
});
