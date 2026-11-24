# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-11-24

First public release of Delivery Loop as a native DeepSeek Harness plugin.

### Added

- Native DSH Host plugin with ten `delivery_*` tools, the `deliver-change` skill, a system-prompt section, and a browser delivery view.
- Persistent task graph and run state under `.delivery/`: `run.json`, an append-only `events.jsonl`, an evidence index, and a cross-run registry.
- Deterministic scheduler and task state machine with dependency, priority, scope, and worker-capacity rules.
- Fresh-context DSH subagent workers with caller-delivered results, `outputSchema` validation, timeouts, cancellation, and token-usage accounting.
- Isolated Git worktrees, patch-based integration, baseline verification, and a final verification matrix at the accepted snapshot.
- Independent review with blocking severities, final review, and repair tasks generated from test failures, review findings, and acceptance gaps.
- Delivery view: a sidebar board grouped by status, a composer strip, a run overlay with overview/tasks/decisions/files/artifacts/events, and tool-call cards.
- Session-authenticated view API with a per-process token fallback, path and symlink validation, and bounded file reads.
- Runtime budget settings page: global and per-repository files, an effective-value view, and **Apply to current run** for paused or blocked runs.
- Recovery and concurrency controls: repository write slots, queue fencing, per-run worker locks, stale-owner recovery, and bounded loop guards.
- Explicit finalization modes (`prepare-only`, `commit`, `branch`, `push`) with `<run-id>:<mode>` confirmation, hooks disabled for commits, and `merge` refused without a project-specific finalizer.
- Vendored, hash-locked generic skills with third-party license notices.
- Bilingual README, documentation set, issue and pull-request templates, security policy, and code of conduct.

### Changed

- The project is DSH-only. The earlier Codex/MCP form and its legacy package paths were removed.
- `prepare-only` is the default Git mode; no commit, push, or merge happens on `COMPLETED`.
- Verification defaults to a fail-closed, digest-pinned container; `trusted-host` is opt-in and cannot be enabled by a repository-level `delivery.yaml`.
- Runtime budgets are resolved in a fixed precedence and frozen into `resolved-config.yaml` at start.

### Fixed

- Recover workers from the DSH inactive-context teardown race instead of leaving tasks in flight.
- Recover the run's parent agent after a page reload or Host restart, with a coordinator fallback.
- Fence queue admission and recovery writes so a stale snapshot cannot overwrite a terminal run state.
- Make run creation atomic and isolate corrupt run directories instead of failing the whole board.
- Inject the view token through `webserver/index-inject` so the Desktop boot payload receives it, with the browser session as the primary credential.
- Handle concurrent state updates order-independently.

### Security

- Fail-closed container verification: no network, no capabilities, read-only source mount, no implicit image pull, and no fallback to host execution.
- `trusted-host` requires approval in the prepared contract and `allow_trusted_host: true` at start.
- View API rejects unauthenticated requests, paths outside the run's repository/worktrees/`.delivery`, and symlink escapes; the settings API accepts only the runtime budget whitelist.
- Finalization commits disable repository hooks, signing, and fsmonitor so delivered content is not executed on the host.
- Evidence logs redact common credential patterns.

### Documentation

- Reworked the README and documentation tree for open-source release; added installation, usage, architecture, operations, troubleshooting, testing, and publishing guides.
- Marked the verification-isolation design as a proposal, not shipped behavior.
- Moved the 0.2.0 development verification record to `docs/reports/`.

[Unreleased]: https://github.com/loveowie/delivery-loop/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/loveowie/delivery-loop/releases/tag/v0.2.0
