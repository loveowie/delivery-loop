import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
const run = async (args: string[]) => {
  const result = await exec('npm', args, {cwd:process.cwd(),maxBuffer:16*1024*1024});
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);
};
const schemaNames=['agent-request','agent-result','delivery-config','task'];
const digest=async()=>Promise.all(schemaNames.map(async name=>createHash('sha256').update(await readFile(join('schemas',`${name}.schema.json`))).digest('hex')));
const before=await digest();await run(['run','generate:schemas']);
if(JSON.stringify(before)!==JSON.stringify(await digest()))throw new Error('generated schemas were stale; review generated changes and rerun');
await run(['run','typecheck']);await run(['run','build']);await run(['run','verify:skills']);await run(['test']);
const directory=await mkdtemp(join(tmpdir(),'delivery-package-check-'));
try {
  const packed=JSON.parse((await exec('npm',['pack','--json','--pack-destination',directory],{maxBuffer:8*1024*1024})).stdout) as Array<{filename:string;files:Array<{path:string}>}>;
  const item=packed[0];if(!item)throw new Error('npm pack produced no package');
  for(const required of ['dist/index.js','dist/worker.js','schemas/agent-result.schema.json','scripts/launch_delivery_mcp','capabilities/skills.lock.yaml'])if(!item.files.some(file=>file.path===required))throw Error(`package missing ${required}`);
  if(item.files.some(file=>file.path.includes('node_modules/')||file.path.endsWith('.DS_Store')))throw Error('package contains machine-local files');
  const unpack=join(directory,'unpack');await mkdir(unpack);await exec('tar',['-xzf',join(directory,item.filename),'-C',unpack]);
  await exec('node',['--check',join(unpack,'package','dist','index.js')]);
  process.stdout.write(`Package layout and entry syntax verified: ${item.filename}\n`);
  const consumer = join(directory, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'delivery-release-check', version: '1.0.0', private: true, type: 'module' }));
  const installed = await exec('npm', ['install', '--omit=dev', '--ignore-scripts', '--registry=https://registry.npmjs.org', join(directory, item.filename)], { cwd: consumer, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(installed.stdout); process.stderr.write(installed.stderr);
  const home = join(directory, 'home'); await mkdir(home);
  const smoke = join(consumer, 'release-stdio-smoke.mjs');
  await copyFile(join(process.cwd(), 'scripts/release-stdio-smoke.mjs'), smoke);
  const checked = await exec(process.execPath, [smoke, join(consumer, 'node_modules', 'delivery-loop'), home], { cwd: consumer, timeout: 20_000, maxBuffer: 1024 * 1024 });
  process.stdout.write(checked.stdout); process.stderr.write(checked.stderr);
  process.stdout.write('Not executed: real Codex smoke, container boundaries, multiprocess crash matrix, isolated installed-package delivery/recovery.\n');
} finally {await rm(directory,{recursive:true,force:true});}
