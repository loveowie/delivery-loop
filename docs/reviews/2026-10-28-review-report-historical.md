# Review Report

## Review method

Two independent read-only Codex review passes were run against the plugin:

- [First full review](reviews/independent-review-1.md): compared the design, implementation and tests and found 30 actionable issues.
- [Second focused review](reviews/independent-review-2.md): rechecked the current code for remaining P1 findings.

## Resolved findings

The implementation and tests were updated for the confirmed issues, including:

- worker and integration locking with `proper-lockfile`;
- atomic state and evidence updates;
- post-worker snapshots so new files are integrated;
- task deltas against staged seed state, avoiding reapplication of earlier tasks;
- integration mutation, snapshot publication and verification under one integration lock;
- attempt-specific worktrees for retries and resumed repair work;
- recovery for running, verifying, reviewing and integrating tasks;
- task cancellation propagation to Worker AbortSignals and integration fencing;
- real manual approve/reject semantics;
- pending dependency promotion;
- repair-task linkage back to source tasks;
- unique dynamic task IDs and aggregate/depth budgets;
- typed independent-review and artifact evidence;
- required final review;
- baseline and final verification matrices;
- actual changed-file and required-output validation;
- finalization snapshot verification;
- Git-native intent-to-add Patch generation for new and binary files;
- Skill run snapshots, project-root resolution and repository registry locking;
- repository-level active write-run limit;
- configuration overrides from the MCP start call and prepared directory;
- graph reference and duplicate-ID validation;
- symlink rejection for the `.delivery` runtime directory;
- linked-worktree baseline selection.

## Remaining material risk

Verification commands run with a filtered environment but under the host process sandbox. There is no portable cross-platform OS sandbox for arbitrary Maven, npm, Gradle or project scripts. A future release should add an explicit sandbox provider or run verification in a container.

This risk is mitigated by:

- commands being fixed before the run starts;
- passing only an environment allowlist;
- running in a task-specific worktree or the integration worktree;
- not exposing inherited API keys and arbitrary secret variables;
- prepare-only delivery as the default.

## Residual limitations

- Token accounting depends on cumulative token information in Codex JSONL events.
- Artifact acceptance requires an external project provider to emit `artifact-check` evidence.
- The Windows process/IPC/locking path is unverified.
- Real Codex Worker execution in a disposable Git repository requires explicit approval for temporary Git writes.

## Review conclusion

All prior P1 findings except the portable OS-sandbox gap were addressed in the current implementation. The remaining sandbox gap is documented as a material residual risk rather than hidden behind an unsupported guarantee.
