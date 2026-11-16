#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const resultFlag = process.argv.indexOf('--output-last-message');
const resultPath = resultFlag >= 0 ? process.argv[resultFlag + 1] : undefined;
const prompt = process.argv.at(-1) ?? '';
const objective = prompt.match(/^Objective: (.*)$/m)?.[1] ?? '';
const option = (name) => objective.match(new RegExp(`${name}=([^ ]+)`))?.[1];

const result = (overrides = {}) => ({
  task_id: 'TASK-1',
  status: 'completed',
  summary: 'fixture completed',
  files_changed: [],
  commands_run: [],
  findings: [],
  remaining_risks: [],
  suggested_tasks: [],
  blockers: [],
  token_usage: 999,
  ...overrides,
});

if (objective.startsWith('mode=ignore-term')) {
  process.on('SIGTERM', () => {
    for (let index = 0; index < 2_000; index += 1) {
      process.stdout.write(`${JSON.stringify({ type: 'diagnostic', index, value: 'y'.repeat(256) })}\n`);
    }
    process.stdout.write('{"type":"event","totals":{"total_tokens":555}}\n', () => process.exit(0));
  });
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  await new Promise((resolve) => child.once('message', resolve));
  await writeFile(option('started'), JSON.stringify({ parent: process.pid, child: child.pid }));
  process.stdout.write('{"type":"event","totals":{"total_tokens":444}}\n');
  setInterval(() => {}, 1_000);
} else if (objective.startsWith('mode=failed-with-usage')) {
  process.stdout.write('{"type":"event","totals":{"total_tokens":321}}\n');
  process.stderr.write('fixture failed\n');
  process.exitCode = 7;
} else if (objective.startsWith('mode=timeout')) {
  process.on('SIGTERM', () => {
    process.stdout.write('{"type":"event","totals":{"total_tokens":654}}\n', () => process.exit(0));
  });
  await writeFile(option('started'), JSON.stringify({ parent: process.pid }));
  setInterval(() => {}, 1_000);
} else if (objective.startsWith('mode=normal-with-descendant')) {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{});process.send?.('ready');setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  await new Promise((resolve) => child.once('message', resolve));
  await writeFile(option('started'), JSON.stringify({ parent: process.pid, child: child.pid }));
  process.stdout.write('{"type":"event","totals":{"total_tokens":777}}\n');
  await writeFile(resultPath, JSON.stringify(result()));
  process.exit(0);
} else if (objective.startsWith('mode=mismatched-task')) {
  process.stdout.write('{"type":"event","totals":{"total_tokens":222}}\n');
  await writeFile(resultPath, JSON.stringify(result({ task_id: 'TASK-OTHER' })));
} else if (objective.startsWith('mode=malformed-result')) {
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":180,"output_tokens":20}}\n');
  await writeFile(resultPath, '{invalid-json');
} else if (objective.startsWith('mode=measured-usage')) {
  process.stdout.write('{"type":"event","totals":{"total_tokens":100}}\n');
  process.stdout.write('{"type":"event","totals":{"total_tokens":150}}\n');
  await writeFile(resultPath, JSON.stringify(result()));
} else if (objective.startsWith('mode=measured-zero')) {
  process.stdout.write('{"type":"turn.completed","usage":{"total_tokens":0}}\n');
  await writeFile(resultPath, JSON.stringify(result()));
} else if (objective.startsWith('mode=unmeasured-self-report')) {
  process.stdout.write('{"type":"diagnostic","message":"no usage event"}\n');
  await writeFile(resultPath, JSON.stringify(result({ token_usage: 0 })));
} else if (objective.startsWith('mode=failed-unmeasured')) {
  process.stderr.write('failed without usage\n');
  process.exitCode = 9;
} else if (objective.startsWith('mode=large-output')) {
  for (let index = 0; index < 2_000; index += 1) {
    process.stdout.write(`${JSON.stringify({ type: 'diagnostic', index, value: 'x'.repeat(256) })}\n`);
  }
  process.stdout.write('{"type":"event","totals":{"total_tokens":175}}\n');
  await writeFile(resultPath, JSON.stringify(result()));
} else if (objective.startsWith('mode=diagnostics')) {
  process.stdout.write('{"type":"event","totals":{"total_tokens":87}}\n');
  process.stderr.write('Authorization: Bearer fixture-secret\n');
  await writeFile(
    resultPath,
    JSON.stringify(result({ summary: 'OPENAI_API_KEY=fixture-secret' })),
  );
} else {
  await writeFile(option('spawned'), 'spawned');
  await writeFile(resultPath, JSON.stringify(result()));
}
