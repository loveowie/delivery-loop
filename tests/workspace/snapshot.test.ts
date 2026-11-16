import test from 'node:test';
import assert from 'node:assert/strict';
import { getRepositoryContext } from '../../src/workspace/repository-context.js';
import type { GitInspector } from '../../src/workspace/repository-context.js';

test('repository context identifies the canonical worktree and git common directory', async () => {
  const inspector: GitInspector = {
    async exec(args) {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') {
        return '/repo/linked\n';
      }
      if (key === 'rev-parse --git-common-dir') {
        return '/repo/main/.git\n';
      }
      if (key === 'worktree list --porcelain') {
        return 'worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/linked\nHEAD def\ndetached\n';
      }
      throw new Error(`unexpected command: ${key}`);
    },
  };

  const context = await getRepositoryContext('/repo/linked', inspector);

  assert.equal(context.worktree_root, '/repo/linked');
  assert.equal(context.canonical_root, '/repo/main');
  assert.equal(context.git_common_dir, '/repo/main/.git');
});

