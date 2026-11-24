# Troubleshooting

Start with the symptom, then collect diagnostics if the quick check does not resolve it. Security issues should follow [SECURITY.md](../SECURITY.md), not this page.

## Quick diagnosis

| Symptom | First check |
| --- | --- |
| A `delivery_*` tool is missing | Is the bundle enabled (not only installed)? Did the Host log `host plugin ready`? |
| The board does not appear | Does the runner compose `webServer`? Is the Client half loaded after a restart? |
| The view returns `401` | Reload the page, then restart Desktop if the package changed |
| `subagent provider "spawn" is not registered` | The composition lacks the spawn provider, or `subagentProvider` names another one |
| Workers can read but not write | The initiating DSH session lacks workspace write permission |
| Verification blocks at the first command | The default `container` backend has no runtime or no digest-pinned image |
| The run is stuck in `WAITING_HUMAN` | Read the pending decision with `delivery_status` and answer it |
| The run is `BLOCKED` | Read the budget or recovery decision; fix the cause, then resume with a larger budget |
| A required skill hash fails | The vendored skill files changed without updating `capabilities/skills.lock.yaml` |
| The graph is rejected at start | Requirements must be covered by a mandatory acceptance condition or a task verification command |
| `401` persists after a reload | Reload the bundle; the plugin may have failed to inject the view token |
| Board lists no runs | No run has started in a registered repository; this is normal for a fresh install |

## Installation and view

### The plugin does not activate

Check the Host log for `[delivery-loop] host plugin ready (root …, api …)`. Activation failures usually mean a missing seam:

- `tools`, `agents`, and `subagents` are required;
- the `webServer` service is optional: without it the view does not load runs over HTTP, but tools still work;
- the view API is always behind a credential; without a browser session or token injection it rejects requests instead of serving run data

If the bundle was installed but not selected, enable it in **Plugins → Installed**.

### The view returns 401

The browser page is running old client code or has no session credential.

1. Reload the DSH page.
2. If it persists, restart the Desktop app so the Host reloads the plugin and re-injects the view token.
3. Confirm that the composition provides DSH's Connection service. Desktop forwards its Host cookie; a web-only composition falls back to the per-process token injected into the page.

A page loaded before the plugin was installed must be refreshed; it cannot fetch the token retroactively.

### The board is empty

The board lists runs from the cross-run registry and repository directories. It is normal for a fresh install to show no runs. `npm run demo:view` creates synthetic data for a source checkout.

### The view loads but file preview or diff fails

The view reads only the run's repository, its managed worktrees, and `.delivery` artifacts. It rejects paths outside those roots, including symlink escapes, and caps file reads. A file deleted after the run completed produces a "not found" response; that is expected.

## Starting a run

### `delivery_start` rejects the graph

Common causes and fixes:

| Message theme | Fix |
| --- | --- |
| No requirement or mandatory acceptance | Declare at least one requirement with coverage |
| Requirement has no coverage | Add a mandatory acceptance condition or a task with `verification_commands` |
| Unknown requirement id | Fix `acceptance[].requirement_id` |
| `capability_profile` mismatch | Make task profiles match `profile` |
| Cyclic graph | Remove the dependency cycle |
| Mandatory `review` acceptance without final review | Set `review.final_review: true` |
| `batch` review policy | Use `risk-based`, `required`, or `none` |
| `custom` spec provider | Use `native` or `openspec` |

### `trusted-host` is rejected

A repository-level `delivery.yaml` cannot select `trusted-host`. Select it in the prepared `delivery.yaml`, and call `delivery_start` with `allow_trusted_host: true` only after the user explicitly approves running commands on the host.

### The run stays `QUEUED`

Another run holds the repository's write slot (`runtime.repository.max_active_write_runs`, default `1`). Wait for it to finish or stop, or raise the limit in configuration if concurrent writes are safe for the repository.

### Preflight fails

- **Git:** the target must be a Git repository with a usable baseline commit.
- **Runtime:** Node 24 or newer.
- **Verification:** the container backend needs a runtime and the configured image.
- **Locks:** a stale lock is recovered; a live lock means another run owns the repository or the run.

## Running

### Workers can read but not write

Workers inherit the initiating session's sandbox and approval policy. Run the delivery from a DSH session with workspace write permission for the repository and worktree root.

### `subagent provider "spawn" is not registered`

The composition does not provide `@deepseek-ai/dsh-subagent-spawn-in-process`, or `subagentProvider` names a provider that is not mounted. Register the provider or set `subagentProvider` to an available one. A provider must support `outputSchema`.

### Verification blocks with a container error

The default backend is fail-closed:

- install a Docker-compatible runtime (or set `verification.execution.command`);
- preload the digest-pinned image named in `verification.execution.image`; the plugin never pulls implicitly;
- for a trusted local project, select `trusted-host` in the approved prepared file and pass `allow_trusted_host: true`.

A missing runtime or image produces error evidence and blocks the run; it never falls back to host execution.

### `usage_incomplete: true`

No assistant-message usage event was observed for a worker. The run remains usable; token budget enforcement is conservative when usage is unknown. This usually means the provider omitted usage metadata.

### A worker times out

The default timeout is `runtime.default_worker_timeout_seconds` (1800). Raise it in the run's Settings page or configuration if the work genuinely needs longer. Timeouts consume an attempt and are bounded by `max_task_attempts`.

### The same failure repeats

The scheduler records a failure fingerprint. If the same fingerprint repeats, the controller stops retrying unchanged and creates a repair task or blocks. Read the task's `failure_context` and the related decision; fix the underlying cause rather than resuming unchanged.

### A patch conflict or worktree validation error appears

The controller rejects a changed `HEAD`, a missing worktree, an unexpected Git root, a deleted `.git` entry, or a missing frozen seed index rather than silently recreating state. Inspect the decision and the integration worktree. Resume only after the conflict is resolved; otherwise start a new run from the current baseline.

### The run is `BLOCKED`

A block is a budget or environment decision, not a generic failure:

- **Budget:** resume with larger `max_total_tokens`, `max_duration_hours`, or `max_task_attempts`, or start a new run.
- **Recovery:** `run_recovery_blocked` means recovery exhausted the attempt budget. Repair the worktree or environment, then start a fresh run if resuming cannot progress.
- **No progress:** the controller saw `no_progress_cycles` cycles without a state change. Inspect the current tasks and decisions.

Budgets can only be increased.

### The run is `WAITING_HUMAN` and no one knows why

Read the pending decision. It contains a `decision_id`, type (`requirement`, `permission`, `environment`, `acceptance`), question, options, and affected tasks. Answer with `delivery_respond`. If the decision is obsolete, answer explicitly instead of cancelling the run, so the answer is recorded in the audit trail.

## Contributing and release checks

### `npm run verify:skills` fails

A vendored `SKILL.md` or resource changed without updating the lock. Either restore the file or regenerate the lock with `npm run update:skills` and review the diff. Vendored content must match its upstream and its recorded SHA-256.

### `npm run verify:release` says schemas are stale

Run `npm run generate:schemas` and commit the regenerated `schemas/*.json`. `verify:release` compares schema digests before running typecheck, build, skills, tests, and the packed-package check.

### `npm pack` contains local files

The `files` whitelist in `package.json` controls the package. Machine-local files such as `.DS_Store`, `.idea/`, and `node_modules/` must not appear; `verify:release` fails on them.

## Collect diagnostics

Include the following in a bug report:

```text
Plugin version:
DSH version:
Node version:
OS:
Install method: marketplace / npm / source
Run id:
Backend: container / trusted-host
Last error:
```

Plus:

- `delivery_status` output;
- the last few `events.jsonl` records;
- the failing task's `failure_context` and the evidence index entry;
- the exact command and error text for verification failures;
- a screenshot of the run view when the problem is visual (redact tokens and paths if needed).

Do not paste credentials, private keys, or full environment dumps. Evidence logs are redacted for common credential patterns, but review before sharing.
