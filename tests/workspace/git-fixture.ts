import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { GitApproval, GitCommandResult } from '../../src/workspace/git-adapter.js';

const execFileAsync = promisify(execFile);

export interface GitFixture {
  path: string;
  baseline: string;
  git(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<GitCommandResult>;
  write(relativePath: string, content: string | Buffer): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createGitFixture(): Promise<GitFixture> {
  const path = await mkdtemp(join(tmpdir(), 'delivery-loop-git-'));

  const git = async (
    args: string[],
    cwd = path,
    env?: NodeJS.ProcessEnv,
  ): Promise<GitCommandResult> => {
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const candidate = error as Error & { code?: number; stdout?: string; stderr?: string };
      if (typeof candidate.code === 'number') {
        return {
          stdout: candidate.stdout ?? '',
          stderr: candidate.stderr ?? '',
          exitCode: candidate.code,
        };
      }
      throw error;
    }
  };

  const checkedGit = async (args: string[], cwd = path, env?: NodeJS.ProcessEnv) => {
    const result = await git(args, cwd, env);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };

  await checkedGit(['init', '--initial-branch=main']);
  await checkedGit(['config', 'user.name', 'Delivery Loop Test']);
  await checkedGit(['config', 'user.email', 'delivery-loop@example.invalid']);
  await checkedGit(['config', 'commit.gpgSign', 'false']);
  await checkedGit(['config', 'core.hooksPath', join(path, '.disabled-hooks')]);
  await mkdir(join(path, '.disabled-hooks'), { recursive: true });
  await mkdir(join(path, 'src'), { recursive: true });
  await writeFile(join(path, 'src', 'tracked.txt'), 'baseline\n');
  await checkedGit(['add', '--', 'src/tracked.txt']);
  await checkedGit(['commit', '-m', 'baseline']);
  const baseline = (await checkedGit(['rev-parse', 'HEAD'])).stdout.trim();

  return {
    path,
    baseline,
    git: checkedGit,
    async write(relativePath, content) {
      const target = join(path, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async cleanup() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

export function fixtureExecutor(fixture: GitFixture): {
  exec(
    args: string[],
    cwd?: string,
    approval?: GitApproval,
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<GitCommandResult>;
} {
  return {
    async exec(args, cwd, _approval, options) {
      return await fixture.git(args, cwd, options?.env);
    },
  };
}
