import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const run = async (args: string[]): Promise<void> => {
  const result = await exec('npm', args, { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
};

const schemaNames = ['agent-request', 'agent-result', 'delivery-config', 'task'];
const digest = async (): Promise<string[]> => await Promise.all(schemaNames.map(async (name) =>
  createHash('sha256').update(await readFile(join('schemas', `${name}.schema.json`))).digest('hex')));

const before = await digest();
await run(['run', 'generate:schemas']);
if (JSON.stringify(before) !== JSON.stringify(await digest())) {
  throw new Error('generated schemas were stale; review generated changes and rerun');
}
await run(['run', 'typecheck']);
await run(['run', 'build']);
await run(['run', 'verify:skills']);
await run(['test']);

const directory = await mkdtemp(join(tmpdir(), 'delivery-package-check-'));
try {
  const packed = JSON.parse((await exec(
    'npm',
    ['pack', '--json', '--pack-destination', directory],
    { maxBuffer: 8 * 1024 * 1024 },
  )).stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const item = packed[0];
  if (item === undefined) throw new Error('npm pack produced no package');

  const required = [
    'dist/dsh/host.js',
    'dist/workers/dsh-subagent-adapter.js',
    'client.js',
    'cordis.patch.yml',
    'icon.svg',
    'locale/zh.json',
    'schemas/agent-result.schema.json',
    'capabilities/skills.lock.yaml',
  ];
  for (const path of required) {
    if (!item.files.some((file) => file.path === path)) throw new Error(`package missing ${path}`);
  }
  const forbidden = [
    '.codex-plugin/',
    '.mcp.json',
    'dist/index.js',
    'dist/worker.js',
    'dist/runtime/detached-worker.js',
    'scripts/launch_delivery_mcp',
    'scripts/release-stdio-smoke.mjs',
  ];
  for (const path of forbidden) {
    if (item.files.some((file) => file.path === path || file.path.startsWith(path))) {
      throw new Error(`package still contains a legacy path ${path}`);
    }
  }
  if (item.files.some((file) => file.path.includes('node_modules/') || file.path.endsWith('.DS_Store'))) {
    throw new Error('package contains machine-local files');
  }

  const unpack = join(directory, 'unpack');
  await mkdir(unpack);
  await exec('tar', ['-xzf', join(directory, item.filename), '-C', unpack]);
  const root = join(unpack, 'package');
  await exec('node', ['--check', join(root, 'dist', 'dsh', 'host.js')]);
  await exec('node', ['--check', join(root, 'client.js')]);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string }; client?: { platform?: string } };
    exports?: { '.': string; './client': string };
  };
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('package is not a DSH bundle');
  if (manifest.dsh?.client?.platform !== 'web') throw new Error('package is missing the web Client half');
  if (manifest.exports?.['.'] !== './dist/dsh/host.js' || manifest.exports?.['./client'] !== './client.js') {
    throw new Error('package exports do not point at the DSH Host and Client halves');
  }
  process.stdout.write(`DSH package layout and entry syntax verified: ${item.filename}\n`);
  process.stdout.write('Not executed: live DSH worker run, container boundaries, multiprocess crash matrix, installed-package delivery/recovery.\n');
} finally {
  await rm(directory, { recursive: true, force: true });
}
