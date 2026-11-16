# Git content implementation review — 2026-11-03

Scope: W2 repository content behavior in `repository-context.ts`, `patch-integrator.ts`,
`worktree-manager.ts`, and focused workspace tests.

## Implemented guarantees

- Snapshot identity is a canonical manifest of sorted repository-relative paths, entry type,
  executable mode, and byte digest. It is independent of index staging and commit identity.
- Each snapshot exposes that canonical manifest as `content_manifest`; `changedSnapshotPaths`
  compares two manifests so inherited accepted changes are not attributed to the next task.
- Deleted paths are represented by absence from the content manifest. This keeps content identity
  stable before and after committing a deletion while manifest comparison still reports the path.
- The manifest includes tracked files, untracked files, deletions, executable-bit changes, and
  symlink targets. `.delivery` and ignored untracked files are excluded.
- Git path lists use NUL-delimited `ls-tree` and porcelain-status records. Rename/copy source
  records are consumed without treating the second path as another status entry.
- Submodules fail explicitly as unsupported content instead of being hashed as ordinary files.
- Full and delta patch exports use temporary `GIT_INDEX_FILE` values. Full exports seed the
  temporary index from the requested baseline; delta exports copy the worktree's staged seed.
  Intent-to-add entries therefore never mutate the real index.
- Empty patches apply successfully without invoking `git apply`.
- Existing task worktrees are reused only after validating the worktree root, common Git
  directory, and baseline `HEAD`.
- Retry worktrees stage the accepted integration seed, then overlay the failed attempt without
  staging it. A later delta export preserves failed-only content together with repair edits.

## Verification

Focused real-Git and compatibility suite:

```text
npx tsx --test \
  tests/workspace/content-snapshot-real-git.test.ts \
  tests/workspace/patch-roundtrip-real-git.test.ts \
  tests/workspace/worktree-manager.test.ts \
  tests/workspace/patch-integrator.test.ts \
  tests/workspace/snapshot.test.ts \
  tests/workspace/patch-integration-adapter.test.ts \
  tests/workspace/git-adapter.test.ts

19 tests passed, 0 failed.
```

The repository-wide TypeScript check currently stops on concurrent, out-of-scope state-store
test mismatches:

```text
tests/state/state-store.test.ts(127,24): error TS2339:
Property 'revision' does not exist on type 'RunState'.
tests/state/state-store.test.ts(127,88): error TS2554: Expected 2 arguments, but got 3.
tests/state/state-store.test.ts(128,59): error TS2554: Expected 2 arguments, but got 3.
```

No type errors were reported for the workspace files or tests in this implementation slice.

## Remaining boundary

This implementation does not add the plan's proposed standalone `ContentSnapshotRef`,
`ChangeSet`, or artifact-store APIs. It strengthens the existing `CodeSnapshot`,
`PatchIntegrator`, and `WorktreeManager` boundaries used by the current controller so the
critical runtime path receives the guarantees without introducing a parallel content system.
