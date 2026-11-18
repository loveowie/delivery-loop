# Operations

Delivery Loop runs inside the DSH Host process. This page covers starting, observing, controlling, and recovering a run.

## Start

Prepare `.delivery/prepared/<draft-id>/` with `spec.md` and `task-graph.json` (and optionally `delivery.yaml`), then call `delivery_start` with the repository root and prepared directory. The tool returns a run id and initial status.

The controller starts immediately in the Host process. A run occupies one repository write slot; additional runs in the same repository are queued until the active run stops or completes.

## Observe

- `delivery_status` returns progress, current tasks, pending decisions, recent decisions and the last error.
- `delivery_inspect` returns the full task graph, requirements, acceptance, decision timeline, evidence index, changed files and artifacts.
- `delivery_watch` waits for progress or a terminal state; use it instead of polling in a tight loop.
- The DSH view shows the same data: the **交付循环** board in the left sidebar, the composer strip, and the full overlay.

Terminal and waiting states are `COMPLETED`, `CANCELLED`, `BLOCKED`, `PAUSED` and `WAITING_HUMAN`.

## Human decisions

A blocked worker or a manual acceptance condition produces a pending decision. Read the exact decision id and options from `delivery_status`, then call `delivery_respond`. A response wakes the controller and resumes affected tasks.

## Control

- `delivery_pause` stops scheduling after the current step.
- `delivery_resume` resumes a paused, queued or blocked run. It resets blocked tasks within the attempt budget and can raise `max_total_tokens`, `max_duration_hours` or `max_task_attempts`; budget-only decreases are rejected.
- `delivery_cancel` aborts running workers and marks unfinished tasks `CANCELLED`; it cannot be undone.
- `delivery_export_report` writes `reports/final.md` into the run directory.
- `delivery_finalize` applies only the explicitly confirmed Git mode; the default is `prepare-only`. `confirmation` must be exactly `<run-id>:<mode>`.

## State layout

```text
<repo>/.delivery/
├── prepared/<draft-id>/          # input prepared by the skill
└── runs/<run-id>/
    ├── run.json                  # authoritative run state
    ├── events.jsonl              # lifecycle and decision events
    ├── spec.md
    ├── task-graph.json
    ├── resolved-config.yaml
    ├── evidence/index.json + logs
    ├── worktrees/                # isolated task and candidate checkouts
    ├── reports/final.md
    └── completion.json
```

`~/.delivery-loop/runs.json` maps run ids to repositories so a restarted Host can resolve a run.

## Workers

Each task worker is a fresh DSH child Agent. The initiating Agent is remembered as the run's parent; if it is gone (for example after a Host restart), the adapter falls back to a live Agent or a coordinator Agent. Workers are caller-delivered, so their results do not appear as settlement messages in the user's conversation.

## Recovery

A restarted Host reloads a run from `run.json` on the next `delivery_status`, `delivery_watch`, `delivery_inspect`, `delivery_resume` or `delivery_respond` call. A run with no live worker-lock owner is recovered: `RUNNING`/`VERIFYING`/`REVIEWING`/`INTEGRATING` tasks are reset to `READY`, the run is queued, and a new loop owns it. Paused runs remain paused. A missing managed worktree, changed HEAD, deleted `.git` entry or missing frozen seed index is rejected rather than silently recreated.

Each executing run holds a per-run worker lock. A second Host or plugin activation cannot start a duplicate loop for the same run; the run stays queued until the owner releases it. Stale `RUNNING` runs without an owner are recovered instead of permanently consuming a repository write slot.

## Troubleshooting

- **`DSH subagent provider "spawn" is not registered`**: the composition lacks `@deepseek-ai/dsh-subagent-spawn-in-process` or configured another provider name. Register the provider or set `subagentProvider`.
- **Workers can read but not write**: the child inherits the initiating session's sandbox and approval policy. Run the delivery from a session with workspace write permission.
- **Verification blocks with a container error**: the default backend is fail-closed. Install a digest-pinned image or explicitly set `verification.execution.backend: trusted-host` for a trusted project.
- **`usage_incomplete: true`**: no assistant-message usage event was observed for a worker. The run remains usable; token budget enforcement is conservative when usage is unknown.
- **View shows 401**: refresh the DSH page so it receives the current per-process view token from the index injection (Web) or boot payload (Desktop). If the token is still missing, reload the plugin bundle; a stale client bundle from before the index-injection fix has no token to send.
