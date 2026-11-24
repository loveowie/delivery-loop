// Test processes must never read the developer's real ~/.delivery-loop
// settings (the global budget file would silently change expectations).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DELIVERY_LOOP_HOME === undefined) {
  process.env.DELIVERY_LOOP_HOME = mkdtempSync(join(tmpdir(), 'delivery-loop-test-home-'));
}
