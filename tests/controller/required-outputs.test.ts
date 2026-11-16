import test from 'node:test';
import assert from 'node:assert/strict';
import { missingRequiredOutputs } from '../../src/controller/required-outputs.js';

test('required code and tests are validated separately', () => {
  assert.deepEqual(
    missingRequiredOutputs(['code', 'test'], ['docs/readme.md']),
    ['code', 'test'],
  );
  assert.deepEqual(
    missingRequiredOutputs(['code', 'test'], ['src/feature.ts', 'tests/feature.test.ts']),
    [],
  );
});

test('documentation, migration and configuration outputs recognize common paths', () => {
  assert.deepEqual(
    missingRequiredOutputs(
      ['documentation', 'migration', 'configuration'],
      ['docs/design.md', 'db/migrations/V2__change.sql', 'config/app.yaml'],
    ),
    [],
  );
});
