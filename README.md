# Delivery Loop

Delivery Loop is a Codex plugin for generic, resumable end-to-end software delivery. It turns an approved specification into a persistent task DAG, runs isolated Codex workers, verifies their changes, converts test and review failures into new tasks, and continues until acceptance passes or a human decision is required.

## What it provides

- `$deliver-change` Skill for intake, one-time approval and status reporting.
- One local MCP server exposing `delivery_*` tools.
- Deterministic scheduler, task state machine, retry limits and failure fingerprints.
- Fresh-context Codex workers for implementation, debugging, review and acceptance.
- Vendored and hash-locked generic Skills; no OpenSpec or domain Skill is required by default.
- Evidence persisted per code snapshot, with invalidation after integration changes.
- Isolated Git worktrees, Patch-based integration and `prepare-only` delivery by default.

## Install from this checkout

Requirements:

- Node.js 24+
- Codex CLI authenticated on the same machine
- Git for the target repository

```bash
npm install
npm run generate:schemas
npm run build
npm run verify:skills
npm test
```

The plugin root is this directory. It contains `.codex-plugin/plugin.json`, `.mcp.json`, the discoverable `skills/` directory and the compiled MCP server in `dist/`.

## Use

Call the Skill explicitly:

```text
使用 $deliver-change 完成以下需求，并持续实现、修复、评审和验收：

<需求>
```

The Skill prepares:

```text
.delivery/prepared/<draft-id>/
├── spec.md
├── task-graph.json
└── delivery.yaml (optional; repository root configuration is preferred)
```

After you approve the scope and acceptance summary, the MCP workflow starts with `delivery_start`. Progress is available through `delivery_status` and `delivery_watch`.

## Defaults

- `portable` profile with native specifications.
- Maximum two parallel workers.
- One active write run per repository.
- Isolated detached worktrees per task.
- `prepare-only` Git mode: no commit, push, merge or deployment.
- Human confirmation required for `delivery_finalize` actions.

## Documentation

- [Configuration](docs/configuration.md)
- [Operations](docs/operations.md)
- [Evaluation](docs/evaluation.md)
- [Design](docs/design/codex-end-to-end-delivery-plugin-design.md)
- [Original implementation plan](docs/superpowers/plans/2026-10-28-delivery-loop-plugin.md)
- [Global reliability plan](docs/superpowers/plans/2026-10-28-global-reliability-plan.md)
- [Current implementation assessment](docs/reviews/2026-11-03-global-implementation.md)
- [Verification report](docs/verification-report.md)
- [Review report](docs/review-report.md)

The existing `release/delivery-loop-0.1.0.tgz` predates the November 3 reliability fixes and has not been rebuilt or released. See [implementation status](docs/implementation/2026-11-03-progress.md).

## Runtime mode

The MCP gateway starts a detached controller process for each active run. The controller holds a run-level worker lock, persists all state under the target repository's `.delivery/`, and exits when the run reaches a terminal, paused, blocked or waiting-human state. A restarted MCP gateway can resolve the repository from `~/.delivery-loop/runs.json` and resume execution. Tests may inject an in-process controller to keep feedback deterministic.

## Current reliability limits

- Local verification was performed on macOS. A macOS/Linux CI workflow is provided but has not been run remotely in this implementation session; Windows remains unverified.
- Known JSONL usage is counted across successful, failed and review calls; unknown usage is explicitly reported. Strict invocation deduplication, reservations and a stop-on-unknown budget policy remain unfinished.
- Verification defaults to a fail-closed container backend requiring a preloaded digest-pinned image. This host has no container runtime; actual isolation validation remains pending. Explicit trusted-host mode is available for trusted projects.
- Artifact acceptance requires typed `artifact-check` evidence from a project provider.
- The `merge` finalization mode requires a project-specific finalizer.
- Real Git tests use scripted workers. Temporary production installation and stdio MCP startup are verified. Paid Codex protocol smoke, container boundaries, multiprocess crash/fencing and installed-package delivery/recovery remain pending.

The November 3 changes repair content snapshots, failure-context recovery, candidate publication, read-only review, final check planning, process termination and FIFO admission. Repository lease epochs, a fully atomic run/evidence/usage journal, cross-worktree repository identity and exhaustive crash recovery remain unfinished. Passing unit/integration tests does not certify a production reliability release.
