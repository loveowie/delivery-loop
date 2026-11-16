import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitApproval {
  run_id: string;
}

export interface GitExecutionOptions {
  env?: NodeJS.ProcessEnv;
}

export interface GitExecutor {
  exec(args: string[], cwd?: string, approval?: GitApproval, options?: GitExecutionOptions): Promise<GitCommandResult>;
}

const READ_ONLY_COMMANDS = new Set([
  'rev-parse',
  'status',
  'diff',
  'show',
  'log',
  'ls-files',
  'ls-tree',
  'worktree-list',
]);

function isMutation(args: string[]): boolean {
  const primary = args[0];
  if (primary === undefined) {
    return false;
  }
  if (primary === 'worktree' && args[1] === 'list') {
    return false;
  }
  return !READ_ONLY_COMMANDS.has(primary);
}

export class GuardedGitAdapter implements GitExecutor {
  constructor(private readonly executor: (args: string[], cwd?: string, options?: GitExecutionOptions) => Promise<GitCommandResult>) {}

  async exec(args: string[], cwd?: string, approval?: GitApproval, options?: GitExecutionOptions): Promise<GitCommandResult> {
    if (isMutation(args) && approval?.run_id === undefined) {
      throw new Error(`git approval required for mutation: git ${args.join(' ')}`);
    }
    const result = await this.executor(args, cwd, options);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result;
  }
}

export function createNodeGitExecutor(): (args: string[], cwd?: string, options?: GitExecutionOptions) => Promise<GitCommandResult> {
  return async (args, cwd = process.cwd(), options) => {
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...options?.env },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
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
}
