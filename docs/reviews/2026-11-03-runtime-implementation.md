# Runtime queue and read-path implementation

Date: 2026-11-03

## Implemented behavior

- `QUEUED` runs no longer consume repository write capacity. Only `PLANNING`, `RUNNING`, and `VERIFYING` own a slot.
- Repository admission uses one `.delivery/repository.lock` path for start, wake, recovery, and queue advancement.
- Queued runs are promoted in `created_at` order with `run_id` as a deterministic tie-breaker.
- Promotion changes the persisted state to `PLANNING` while holding the repository lock. Launch happens after releasing the lock, so a launcher or controller can safely take other locks.
- Foreground loops drain the repository queue when they complete, block, pause, cancel, or otherwise stop.
- Admission also counts a live foreground loop or detached worker lock after persisted state becomes terminal. Cancellation therefore releases capacity only when execution ownership actually closes.
- A respond/resume wake during loop shutdown does not create a second owner. Cleanup requeues any newly runnable state and admits it after the old loop exits.
- Detached workers drain the queue after releasing their worker lock. A worker started for a still-queued run performs store-only admission before RuntimeFactory preflight or recovery.
- Detached launcher startup waits for a matching IPC readiness message from the child after runtime initialization. Startup failures and readiness timeouts are returned to admission, persisted as `BLOCKED`, and recorded as `runtime_launch_error`.
- `DeliveryRunManager.read` resolves the repository registry and opens `StateStore` directly. It does not construct a runtime, run preflight, launch a worker, or start a foreground loop.
- `DeliveryRunManager.get` still resolves a mutable runtime for commands, but no longer starts execution as a lookup side effect.
- Status and watch use the read-only path and expose `last_error`, decision blockers, token usage, and completion reference.
- Report export resolves the repository through the manager, ignores an untrusted output root, and includes records from `EvidenceLedger`.
- Worker error handling writes directly through `StateStore`; it does not rebuild a runtime after preflight failure.
- Finalization uses the persisted accepted `integration_worktree` and rejects runs without one.
- Finalization is serialized by a dedicated per-run lock and records an intent/completion journal outside `RunState`. Identical completed retries return the recorded result without invoking Git again; unfinished intents retry in reconciliation mode and validate the accepted snapshot, completion certificate digest, starting HEAD, and resulting branch or remote ref before accepting prior mutation.
- Foreground execution exposes an exit wait that completes after terminal-loop cleanup and queue draining. Ownership accounting and execution-exit tracking are separate, so queue promotion can proceed only after the active loop closes while cleanup callers can await the drain boundary.

## Verification coverage

`tests/runtime/run-manager-queue.test.ts` covers:

- FIFO promotion after an active owner exits.
- Concurrent queue drains admitting only the available capacity.
- Multiple queued runs not consuming active capacity.
- Read-only lookup without runtime construction or launch.
- Foreground completion automatically advancing the next queued run.
- Cancellation keeping the next run queued until an in-flight worker returns.
- Respond/resume wake during loop shutdown requeueing the run without duplicate ownership or stranding it.

`tests/mcp/tools.test.ts` covers:

- Status choosing the read-only manager path.
- Status returning bounded events and persisted failure fields.
- Report export using the resolved repository and persisted evidence.

## Remaining limits

This patch does not implement strong fencing. The v1 `RunState` has no persisted lease token, monotonic epoch, or compare-and-swap guard on controller state and integration writes. The repository lock prevents competing admission decisions, and live foreground-loop or detached-worker ownership is counted until execution exits, but a stale controller is not cryptographically or transactionally prevented from writing after ownership changes.

Finalization recovery is local and idempotent across retries that can observe the journal, repository, and (for push) the remote ref. It does not provide a transaction spanning the journal write, Git object/ref update, and remote server; an external ref change or loss of both journal and repository evidence still requires explicit reconciliation.

Repository identity still uses `repo_root` and `.delivery/repository.lock`; canonical Git common-directory identity is not added in this patch.

The detached queue path is covered through the shared admission helper and worker control flow. The readiness tests exercise child IPC startup and termination, while the real-Git manager test covers foreground execution and cleanup ordering; a separate process-level test for detached queue promotion after worker exit remains future work.
