# Operations

## Status model

The controller persists `DRAFT`, `SPEC_READY`, `QUEUED`, `PLANNING`, `RUNNING`, `VERIFYING`, `WAITING_HUMAN`, `BLOCKED`, `PAUSED`, `COMPLETED` and `CANCELLED`.

Tasks pass through `PENDING`, `READY`, `RUNNING`, `VERIFYING`, optional `REVIEWING`, `INTEGRATING`, `DONE`, and the corresponding interruption, repair or cancellation states.

## MCP tools

- `delivery_start`: create and start an approved run.
- `delivery_status`: return a bounded summary and latest events.
- `delivery_watch`: wait for progress within the supplied timeout.
- `delivery_respond`: answer a pending human decision.
- `delivery_pause`, `delivery_resume`, `delivery_cancel`: control a run.
- `delivery_export_report`: write `reports/final.md`.
- `delivery_finalize`: execute an explicitly confirmed finalization mode.

## State layout

```text
.delivery/runs/<run-id>/
├── run.json
├── resolved-config.yaml
├── spec.md
├── requirements.json
├── task-graph.json
├── events.jsonl
├── evidence/
├── snapshots/
├── worker-results/
├── reports/
├── runtime-skills/
├── worktrees/
└── delivery.patch
```

The plugin excludes `.delivery/` from Git snapshots and generated patches. It does not modify `.gitignore` automatically.

## Recovery

The MCP gateway starts a detached controller process for each active run. The registry normally records the run-to-repository mapping automatically, so `delivery_status` can reload it after the gateway restarts. `repo_root` is available as an override. `delivery_resume` starts the controller again for a paused or blocked run.

Interrupted tasks return to `READY` unless unresolved human decisions still block them. Existing managed worktrees are reused after validation; original failure context and repair seeds are retained. A missing frozen seed index is rejected. Status/report can read stored diagnostics even when Codex or installed Skill configuration is unavailable.

## Security boundaries

- Workers are launched with the current Codex authentication and `workspace-write` sandbox.
- Secrets are never intentionally persisted; command logs redact common token and password forms.
- Worker prompts prohibit recursive Delivery Loop execution; this is a protocol constraint, not a complete operating-system capability boundary.
- Git mutations other than approved worktree operations require an explicit completion confirmation.
- The MCP server communicates over stdio and does not open a public network port.

## Reliability boundary

See [the implementation assessment](reviews/2026-11-03-global-implementation.md) for current guarantees and incomplete contracts. State files use durable atomic replacement and revisions; events, evidence, usage and Git side effects are not one transaction. Repository admission has no lease epoch fencing and no cross-worktree common-directory coordination. Unknown usage is visible but does not yet impose a hard stop.

Verification defaults to container execution and does not fall back to the host. Trusted-host execution must be explicitly selected. Container execution is not validated on this development host. A missing runtime, pinned image, or failed launch blocks execution; fix the environment before resuming. Container exit codes 125–127 are classified as execution errors. Baseline ordinary test failures remain recorded diagnostics and do not automatically quarantine pre-existing failures.

Finalization writes `finalization/journal.json`; reports display the recorded action/status/result. A repeated identical completed request does not execute Git again, while an interrupted intent reconciles observable refs. This is not an atomic transaction with local Git or the remote.
