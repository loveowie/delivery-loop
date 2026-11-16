import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CodeSnapshot } from '../domain/types.js';

const execFileAsync = promisify(execFile);

export interface GitInspector {
  exec(args: string[], cwd?: string): Promise<string>;
}

export interface RepositoryContext {
  worktree_root: string;
  canonical_root: string;
  git_common_dir: string;
}

export class NodeGitInspector implements GitInspector {
  async exec(args: string[], cwd = process.cwd()): Promise<string> {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
  }
}

function absoluteGitPath(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export async function getRepositoryContext(
  workdir: string,
  inspector: GitInspector = new NodeGitInspector(),
): Promise<RepositoryContext> {
  const worktreeRoot = (await inspector.exec(['rev-parse', '--show-toplevel'], workdir)).trim();
  const commonValue = (await inspector.exec(['rev-parse', '--git-common-dir'], workdir)).trim();
  const gitCommonDir = absoluteGitPath(commonValue, worktreeRoot);
  const worktreeList = await inspector.exec(['worktree', 'list', '--porcelain'], workdir);
  const firstWorktree = worktreeList
    .split('\n')
    .find((line) => line.startsWith('worktree '))
    ?.slice('worktree '.length)
    .trim();

  if (firstWorktree === undefined || firstWorktree.length === 0) {
    throw new Error('git worktree list did not return a canonical worktree');
  }

  return {
    worktree_root: worktreeRoot,
    canonical_root: firstWorktree,
    git_common_dir: gitCommonDir,
  };
}

interface ManifestEntry {
  path: string;
  type: 'deleted' | 'file' | 'symlink';
  mode: string;
  digest: string;
}

type ContentManifest = NonNullable<CodeSnapshot['content_manifest']>;

function isRuntimePath(path: string): boolean {
  return path === '.delivery' || path.startsWith('.delivery/');
}

function parseTrackedPaths(tree: string): Set<string> {
  const paths = new Set<string>();
  for (const record of tree.split('\0')) {
    if (record.length === 0) {
      continue;
    }
    const tab = record.indexOf('\t');
    if (tab < 0) {
      throw new Error('git ls-tree returned a malformed record');
    }
    const metadata = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (metadata[0] === '160000') {
      throw new Error(`unsupported git submodule: ${path}`);
    }
    if (!isRuntimePath(path)) {
      paths.add(path);
    }
  }
  return paths;
}

function parseWorktreePaths(status: string): string[] {
  const paths: string[] = [];
  const records = status.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) {
      continue;
    }
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('git status returned a malformed record');
    }
    const state = record.slice(0, 2);
    const path = record.slice(3);
    if (!isRuntimePath(path)) {
      paths.push(path);
    }
    if (state.includes('R') || state.includes('C')) {
      index += 1;
    }
  }
  return paths;
}

async function manifestEntry(root: string, path: string): Promise<ManifestEntry> {
  const absolutePath = join(root, path);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, type: 'deleted', mode: '000000', digest: '' };
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const target = await readlink(absolutePath, { encoding: 'buffer' });
    return {
      path,
      type: 'symlink',
      mode: '120000',
      digest: createHash('sha256').update(target).digest('hex'),
    };
  }
  if (!stats.isFile()) {
    throw new Error(`unsupported worktree entry type: ${path}`);
  }
  return {
    path,
    type: 'file',
    mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
    digest: createHash('sha256').update(await readFile(absolutePath)).digest('hex'),
  };
}

export function changedSnapshotPaths(before: CodeSnapshot, after: CodeSnapshot): string[] {
  if (before.content_manifest === undefined || after.content_manifest === undefined) {
    throw new Error('content manifest is required to compare snapshots');
  }
  const paths = new Set([
    ...Object.keys(before.content_manifest),
    ...Object.keys(after.content_manifest),
  ]);
  return [...paths]
    .filter((path) => {
      const previous = before.content_manifest?.[path];
      const current = after.content_manifest?.[path];
      return (
        previous?.type !== current?.type ||
        previous?.mode !== current?.mode ||
        previous?.digest !== current?.digest
      );
    })
    .sort();
}

export async function createCodeSnapshot(
  workdir: string,
  inspector: GitInspector = new NodeGitInspector(),
): Promise<CodeSnapshot> {
  const baselineCommit = (await inspector.exec(['rev-parse', 'HEAD'], workdir)).trim();
  const trackedPaths = parseTrackedPaths(
    await inspector.exec(['ls-tree', '-r', '-z', baselineCommit], workdir),
  );
  const changedPaths = parseWorktreePaths(
    await inspector.exec(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workdir),
  );
  const allPaths = [...new Set([...trackedPaths, ...changedPaths])].sort();
  const entries = (
    await Promise.all(allPaths.map(async (path) => await manifestEntry(workdir, path)))
  ).filter((entry) => entry.type !== 'deleted');
  const untrackedFiles = changedPaths.filter((path) => !trackedPaths.has(path)).sort();
  const contentManifest: ContentManifest = Object.fromEntries(
    entries.map(({ path, type, mode, digest }) => [path, { type, mode, digest }]),
  );
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.type);
    hash.update('\0');
    hash.update(entry.mode);
    hash.update('\0');
    hash.update(entry.digest);
    hash.update('\0');
  }

  const worktreeDigest = hash.digest('hex');
  return {
    id: `SNAP-${worktreeDigest.slice(0, 12)}`,
    created_at: new Date().toISOString(),
    baseline_commit: baselineCommit,
    worktree_digest: worktreeDigest,
    content_manifest: contentManifest,
    untracked_files: untrackedFiles,
  };
}
