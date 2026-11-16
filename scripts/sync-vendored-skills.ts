import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

interface LockEntry {
  path: string;
  entry: string;
  sha256: string;
  resources?: string[];
}

interface LockFile {
  version: number;
  skills: Record<string, LockEntry>;
}

const root = process.cwd();
const lockPath = join(root, 'capabilities', 'skills.lock.yaml');
const lock = parseYaml(await readFile(lockPath, 'utf8')) as LockFile;
const write = process.argv.includes('--write');
let changed = false;
let invalid = false;

for (const [skillId, entry] of Object.entries(lock.skills)) {
  const entryPath = resolve(root, entry.path, entry.entry);
  if (!entryPath.startsWith(`${resolve(root, entry.path)}/`)) {
    throw new Error(`invalid skill path for ${skillId}`);
  }
  const digest = createHash('sha256').update(await readFile(entryPath)).digest('hex');
  if (digest !== entry.sha256) {
    if (write) {
      console.log(`updated ${skillId}: ${entry.sha256} -> ${digest}`);
      entry.sha256 = digest;
      changed = true;
    } else {
      console.error(`hash mismatch for ${skillId}: expected ${entry.sha256}, got ${digest}`);
      invalid = true;
    }
  }
  for (const resource of entry.resources ?? []) {
    await readFile(resolve(root, entry.path, resource));
  }
}

if (changed) {
  await writeFile(lockPath, stringifyYaml(lock), 'utf8');
}
if (invalid) {
  process.exitCode = 1;
} else if (!changed) {
  console.log(`verified ${Object.keys(lock.skills).length} vendored Skills`);
}
