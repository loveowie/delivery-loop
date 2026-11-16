#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index], process.argv[index + 1]);
}
const runId = values.get('--run');
const mode = process.env.DELIVERY_FIXTURE_MODE ?? 'ready';
const pidPath = process.env.DELIVERY_FIXTURE_PID_PATH;
if (pidPath) await writeFile(pidPath, String(process.pid));

if (mode === 'ready') {
  setTimeout(() => {
    process.send?.({ type: 'ready', run_id: runId, phase: 'runtime_initialized' });
    process.disconnect?.();
  }, Number(process.env.DELIVERY_FIXTURE_DELAY_MS ?? 0));
} else if (mode === 'error') {
  process.on('SIGTERM', () => {});
  process.send?.({ type: 'error', run_id: runId, message: 'fixture startup failed' });
  setInterval(() => {}, 1_000);
} else if (mode === 'wrong-run') {
  process.on('SIGTERM', () => {});
  process.send?.({ type: 'ready', run_id: `${runId}-other`, phase: 'runtime_initialized' });
  setInterval(() => {}, 1_000);
} else if (mode === 'silent') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else if (mode === 'exit') {
  process.exitCode = 7;
}
