# Operations

This page covers running Delivery Loop day to day: starting work, observing it, handling decisions, recovering from interruptions, and managing state. For the workflow narrative and command examples, see [Usage](usage.md).

## Operational model

- The controller runs inside the DSH Host process. There is no detached controller or external worker process to supervise.
- One repository admits `runtime.repository.max_active_write_runs` writing runs (default `1`). Additional runs wait in `QUEUED`.
- Each executing run holds a worker lock, so a second Host or plugin activation cannot run the same run concurrently.
- Run state is durable. A Host restart does not lose an accepted run; the next tool call or view request can recover it.

## Start

Prepare `.delivery/prepared/<draft-id>/` with `spec.md` and `task-graph.json` (and optionally `delivery.yaml`), then call `delivery_start` with the repository root and prepared directory. The tool returns the run id and initial status.

The run is admitted, preflight runs (Git, runtime, verification backend, repository and worker locks), the baseline verification records pre-existing failures, and the controller starts.

## Observe

| Surface | What it shows |
| --- | --- |
| `delivery_status` | Progress counts, current tasks, pending decisions, recent decisions, last error |
| `delivery_inspect` | Full graph, requirements, acceptance, decision timeline, evidence index, changed files, artifacts |
| `delivery_watch` | Wait for progress or a terminal state; use it instead of polling |
| DSH board | Runs by repository and status, progress, tokens, last update |
| Run view | Overview, Tasks, Decisions, Files, Artifacts, Events |
| `events.jsonl` | Append-only lifecycle and decision events for one run |

There is no metrics endpoint. For automation, read `run.json`, `completion.json`, and `events.jsonl` from the run directory.

## Human decisions

A blocked worker or a manual acceptance condition produces a pending decision. Read the exact `decision_id`, question, and options from `delivery_status` or the Decisions tab, then call `delivery_respond`. A response wakes the controller and resumes affected tasks.

Rejecting a manual acceptance creates an `acceptance_gap` repair task; it does not leave the run silently waiting. Workers cannot ask the user directly, so every human question appears as a controller decision.

## Control

| Operation | Effect |
| --- | --- |
| `delivery_pause` | Stop scheduling after the current step; keep durable state |
| `delivery_resume` | Resume a paused, queued, or blocked run; resets blocked tasks within the attempt budget; can raise budgets |
| `delivery_cancel` | Abort running workers and mark unfinished tasks `CANCELLED`; irreversible |
| `delivery_export_report` | Write `reports/final.md` |
| `delivery_finalize` | Apply the explicitly confirmed Git mode; default `prepare-only` |

Budget increases are accepted from `delivery_resume` or from the run's Settings page (**Apply to current run**). A decrease requires a new run. A pause is not a cancel: paused runs keep their worktrees and evidence and can resume.

## State layout

```text
<repo>/.delivery/
├── prepared/<draft-id>/          # input prepared by the skill
├── settings.yaml                 # optional repository budget overrides
└── runs/<run-id>/
    ├── run.json                  # authoritative run state
    ├── events.jsonl              # lifecycle and decision events
    ├── spec.md
    ├── task-graph.json
    ├── resolved-config.yaml
    ├── evidence/index.json + logs
    ├── worktrees/                # isolated task and candidate checkouts
    ├── reports/final.md
    ├── completion.json
    └── delivery.patch
```

Per-user state lives under `~/.delivery-loop/` (or `$DELIVERY_LOOP_HOME`):

- `runs.json` — maps run ids to repositories so a restarted Host can resolve a run;
- `settings.json` — global runtime budget defaults.

## Recovery

On the next `delivery_status`, `delivery_watch`, `delivery_inspect`, `delivery_resume`, or `delivery_respond` call after a restart, a run whose worker lock has no live owner is recovered:

- `RUNNING` / `VERIFYING` / `REVIEWING` / `INTEGRATING` tasks reset to `READY`;
- recovery consumes one attempt;
- the run is queued and a new loop owns it;
- paused runs stay paused.

A run with no live owner is recovered instead of permanently consuming a repository write slot. A missing managed worktree, changed `HEAD`, deleted `.git` entry, unexpected Git root, or missing frozen seed index is rejected rather than silently recreated; the controller records the error and blocks or asks for a decision.

If recovery exhausts the attempt budget, the run becomes `BLOCKED` with `run_recovery_blocked`. Inspect the worktree and repair the cause before resuming with a larger budget.

## Retention and cleanup

Delivery Loop does not prune run data automatically. A long-lived repository accumulates worktrees, evidence logs, and patches under `.delivery/`.

Safe cleanup order:

1. Confirm the run is `COMPLETED` or `CANCELLED`, and that you no longer need its patch or worktrees.
2. Keep `reports/final.md` and `completion.json` if you need an audit trail.
3. Delete `.delivery/runs/<run-id>/` when the run is closed.
4. Leave the cross-run entry in `~/.delivery-loop/runs.json` unless you are also removing the run directory; there is no prune command in 0.2.0.

Do not delete `run.json` or the evidence index while a run is active. `.delivery/` and `.delivery-loop/` are not Git-tracked by this project; add them to your repository's `.gitignore` if your target repository does not already ignore them.

## Upgrades

1. Finish, pause, or cancel active runs.
2. Update the bundle and restart the Desktop app (a browser-only change needs a reload).
3. Open the board and confirm runs are still listed.
4. Read the [changelog](../CHANGELOG.md) for state or behavior changes before resuming long runs.

Run state is versioned (`state_schema_version: 1`). Upgrading does not migrate or delete existing run directories.

## Backups

The authoritative state for a run is its `.delivery/runs/<run-id>/` directory. To back up a repository's delivery state, copy that directory (or the whole `.delivery/` tree) while no run is active, and copy `~/.delivery-loop/runs.json`. Evidence logs can be large; a backup that keeps `run.json`, `task-graph.json`, `resolved-config.yaml`, `reports/`, and `completion.json` preserves the audit trail without the worktrees.

## Operational safety

- Treat `.delivery/prepared/` as approved input. Changing a prepared file after start has no effect; start a new run instead.
- Do not edit `run.json` by hand. Writes are revision-guarded; an external edit is detected as a conflict or corruption.
- Prefer `prepare-only` for shared branches. Finalization commits disable repository hooks, but a human review is still the last line of defense.
- Verification defaults to a fail-closed container. A host without a container runtime will block at the first command; use a prepared `delivery.yaml` with `trusted-host` only for trusted projects and with explicit user approval.

## Diagnostics

Collect these before asking for help:

- run id, plugin version, DSH version, Node version, OS;
- `delivery_status` output and the last error;
- the relevant records from `events.jsonl` and `evidence/index.json`;
- the last decision and the task's `failure_context`;
- whether verification uses `container` or `trusted-host`, and whether the image or runtime is available.

See [Troubleshooting](troubleshooting.md) for symptom-based steps and [Security](../SECURITY.md) for reporting a vulnerability.
