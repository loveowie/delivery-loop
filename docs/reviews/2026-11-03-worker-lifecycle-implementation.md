# Worker Lifecycle Implementation Review

Date: 2026-11-03

## Implemented

- Added `src/runtime/process-supervisor.ts` with pre-abort rejection, configurable TERM grace, process-group KILL escalation, direct-child close tracking, output-stream flush tracking, timer/listener cleanup, explicit `cwd`/`env`, and bounded post-KILL group verification.
- Updated `CodexExecAdapter` to wait for confirmed process completion before reading results, preserve measured usage on non-zero exits and parse/protocol failures, discard worker-reported usage and accept only valid measured JSONL usage (including measured zero), and reject mismatched `task_id` values.
- Added optional `diagnosticDirectory` retention. Retained JSONL, stderr, and result artifacts are sanitized before being written under a per-invocation directory.
- Added optional `terminationGraceMs`; the default remains 5 seconds.
- Added the frozen structured request context to the worker prompt when present.

## Tests

The process tests launch real local Node child processes. They cover:

- pre-aborted signals without spawning;
- aborting a leader that exits on TERM while its descendant ignores TERM;
- timeout termination and final usage flush;
- spawn errors;
- large stdout flush before result parsing;
- non-zero exit usage retention;
- malformed result usage retention;
- measured usage overriding worker-reported usage, including measured zero;
- `task_id` mismatch rejection;
- sanitized diagnostic retention;
- explicit supervisor `cwd` and isolated `env`.

Verification commands:

```text
npx tsx --test tests/workers/process-supervisor.test.ts tests/workers/codex-exec-adapter.test.ts tests/workers/codex-process-contract.test.ts
npm run typecheck
npm run build
npm test
```

Final integrated verification: `npm run verify:release` passed typecheck, build and all 197 tests, independent production installation and stdio MCP startup. Earlier intermediate controller/fixture failures were resolved; retained intermediate counts do not describe the final source. Added follow-up coverage confirms normal worker exit cleans up lingering same-group descendants, missing/invalid usage remains unknown, real detached IPC readiness, and frozen Skill recovery without installed capability files.

## Limits

- Process-group supervision uses POSIX negative-PID signaling. Windows falls back to direct-child signaling and cannot provide the same descendant guarantee.
- After SIGKILL, group disappearance is polled for a bounded interval (`max(terminationGraceMs, 1000ms)`). If termination cannot be confirmed, the supervisor rejects instead of reporting completion or polling indefinitely. PID start-time identity verification is not available in this focused implementation.
- The optional retained diagnostic copy is sanitized after process completion. Temporary raw files exist during execution and are deleted afterward unless the legacy `DELIVERY_KEEP_WORKER_LOGS=1` setting is enabled.
- Log size capping and cross-chunk streaming redaction from the broader W5 plan remain outside this focused adapter repair.
