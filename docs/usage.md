# Usage

This guide walks through one delivery from request to finalization and documents the prepared files and tools. For installation, see [Installation](installation.md); for every configuration field, see [Configuration](configuration.md).

## Mental model

Delivery Loop has two gates and one loop.

- **Approval gate.** You approve the specification, task graph, acceptance conditions, and verification policy once, before the run starts.
- **Delivery loop.** The controller schedules tasks, runs workers, verifies evidence, reviews, integrates, and either continues or asks a question.
- **Finalization gate.** A Git action happens only when you explicitly confirm a mode with `delivery_finalize`.

The default Git mode is `prepare-only`: the run produces an integration worktree and `delivery.patch` without touching your main checkout. Nothing is committed, pushed, or merged unless you confirm it.

## 1. Ask for a delivery

Use the skill name explicitly. Delivery Loop is not a generic "do this task" mode; it is for work that should be carried through implementation, verification, review, and acceptance.

```text
Use deliver-change to deliver this change end to end, and keep going until
it is verified and accepted:

Add cursor pagination to GET /api/items (limit, after), keep the existing
offset parameters working, update the OpenAPI document, and cover both
paths with tests.
```

The skill reads the repository's `AGENTS.md` and relevant documentation, then asks about anything that would make the run unplannable: scope, non-goals, acceptance, verification commands, Git policy, risk, and budget. Missing product rules block preparation; missing implementation details are left to the planner.

## 2. Review the prepared run

The skill writes:

```text
.delivery/prepared/<draft-id>/
├── spec.md            # goal, scope, non-goals, acceptance
├── task-graph.json    # requirements, acceptance, tasks
└── delivery.yaml      # optional; overrides repository configuration
```

The prepared `delivery.yaml` is where run-specific policy belongs, especially verification. `delivery_start` interprets this directory as the approved contract; editing it after start has no effect because the merged configuration is frozen into `.delivery/runs/<run-id>/resolved-config.yaml`.

### `spec.md`

`spec.md` is free-form Markdown, but keep it reviewable:

```markdown
# Add cursor pagination

## Goal

Support stable cursor pagination on `GET /api/items` without breaking offset clients.

## Scope

- `src/api/items.ts`
- `src/api/openapi.yaml`
- `tests/api/items.test.ts`

## Acceptance

- `limit` + `after` returns a stable page and an opaque next cursor.
- Offset parameters keep their current behavior.
- The OpenAPI document describes both forms.
- The test suite passes.

## Non-goals

- No database migration.
- No client changes.

## Risks

- Cursor stability under concurrent inserts; cover with a deterministic test.
```

### `task-graph.json`

The graph must be acyclic and every requirement must be satisfiable. A minimal graph:

```json
{
  "run_id": "draft",
  "requirements": [
    { "id": "REQ-1", "description": "Cursor pagination is supported", "status": "PENDING" }
  ],
  "acceptance": [
    {
      "id": "AC-1",
      "requirement_id": "REQ-1",
      "description": "Pagination tests pass",
      "verification": { "type": "command", "command": "npm test -- tests/api/items.test.ts", "expected_exit_code": 0 },
      "mandatory": true,
      "risk": "medium"
    }
  ],
  "tasks": [
    {
      "id": "TASK-1",
      "type": "implementation",
      "title": "Implement cursor pagination and tests",
      "status": "READY",
      "priority": "normal",
      "risk": "medium",
      "origin": "initial_plan",
      "depends_on": [],
      "requirement_ids": ["REQ-1"],
      "acceptance_ids": ["AC-1"],
      "scope_paths": ["src/api/items.ts", "tests/api/items.test.ts"],
      "required_outputs": ["code", "test"],
      "worker_role": "implementer",
      "capability_profile": "portable",
      "attempt": 0,
      "max_attempts": 3,
      "verification_commands": ["npm test -- tests/api/items.test.ts"],
      "review_policy": "required"
    }
  ]
}
```

`run_id` is replaced by the actual run id at start. Task fields:

| Field | Values | Notes |
| --- | --- | --- |
| `type` | `spec`, `implementation`, `test`, `bugfix`, `refactor`, `integration`, `verification`, `documentation`, `review_fix` | Selects the worker prompt |
| `status` | `PENDING`, `READY` | Initial graph uses `READY`; the scheduler owns state afterwards |
| `priority` | `low`, `normal`, `high`, `critical` | Ordering among ready tasks |
| `risk` | `low`, `medium`, `high`, `critical` | Drives the default risk-based review policy |
| `origin` | `initial_plan` | New dynamic tasks use failure origins |
| `depends_on` | task ids | A dependency unlocks only after it is integrated and `DONE` |
| `requirement_ids` / `acceptance_ids` | ids | Traceability |
| `scope_paths` | repository-relative paths | Workers are checked against this scope |
| `required_outputs` | `code`, `test`, `documentation`, `migration`, `configuration` | Missing outputs fail verification |
| `worker_role` | `planner`, `implementer`, `test_author`, `debugger`, `reviewer`, `acceptance` | Selects the worker prompt and worker profile |
| `capability_profile` | `portable`, `openspec` | Must match the run profile |
| `verification_commands` | shell commands | Re-run by the controller, never trusted from the worker |
| `review_policy` | `required`, `risk-based`, `none` | `batch` is rejected |

### Acceptance types

| Type | How it is satisfied |
| --- | --- |
| `command` / `test` | The controller runs the command at the accepted snapshot and compares the exit code |
| `manual` | The run enters `WAITING_HUMAN`; your approval is recorded as evidence bound to the current snapshot. Rejection creates an `acceptance_gap` repair task |
| `artifact` | Checked against the produced `delivery.patch` digest |
| `review` | Requires `review.final_review: true` and a passing independent review |

At least one requirement and one of the following must exist: a mandatory acceptance condition, or a task that covers the requirement and declares verification commands. Otherwise `delivery_start` rejects the graph instead of starting a run that can only block at acceptance.

### `delivery.yaml`

The optional prepared file overrides the repository configuration for this run. Use it for run-specific budgets or verification policy:

```yaml
version: 1
profile: portable

verification:
  execution:
    backend: trusted-host
  commands:
    test: ["npm test"]
```

Verification policy must be in the approved file, not in a `delivery_start` override. Repository-level `delivery.yaml` cannot select `trusted-host`.

## 3. Approve and start

The skill shows the final scope and acceptance summary. After you approve, the agent calls `delivery_start` with the repository root, the prepared directory, and optionally a stable `run_id`. The tool:

1. validates the graph (acyclic, known ids, satisfiable requirements, profile match);
2. inspects the repository and records the baseline commit;
3. freezes the merged configuration;
4. queues the run and starts the controller in the Host process.

`delivery_start` arguments:

| Argument | Required | Meaning |
| --- | --- | --- |
| `prepared_directory` | yes | Directory containing `spec.md` and `task-graph.json` (and optionally `delivery.yaml`) |
| `repo_root` | no | Target repository; defaults to the session working directory |
| `run_id` | no | Stable id; defaults to a generated timestamped id |
| `config_override` | no | Runtime, review, Git, or worker overrides only; verification policy must be approved in the file |
| `allow_trusted_host` | no | `true` only after you explicitly approve host-shell verification for this run |

By default, a repository has one active write slot. Additional runs in the same repository stay `QUEUED` until the active run stops or completes.

## 4. Observe

- `delivery_status` returns bounded progress, current tasks, pending decisions, recent decisions, and the last error.
- `delivery_inspect` returns the full graph, requirements, acceptance, decision timeline, evidence index, changed files, and artifacts.
- `delivery_watch` waits for progress or a terminal state instead of tight polling.
- The DSH view shows the same data: the sidebar board, the composer strip, and the full run view.

Run states are `DRAFT`, `SPEC_READY`, `QUEUED`, `PLANNING`, `RUNNING`, `VERIFYING`, `WAITING_HUMAN`, `BLOCKED`, `PAUSED`, `COMPLETED`, and `CANCELLED`. Terminal or waiting states are `COMPLETED`, `CANCELLED`, `BLOCKED`, `PAUSED`, and `WAITING_HUMAN`.

A task is complete only after its patch is integrated. Worker-reported completion is an input, not proof: the controller re-runs task and acceptance commands at the accepted snapshot.

## 5. Answer decisions

When a worker is blocked by a permission, environment, requirement, or manual acceptance question, the run enters `WAITING_HUMAN` and records a decision.

1. Read the exact `decision_id`, question, and options from `delivery_status`.
2. Decide with the user; do not guess.
3. Call `delivery_respond` with the run id, decision id, and the answer text.

A response wakes the controller and resumes the affected tasks. A rejected manual acceptance creates a repair task rather than leaving the run waiting unchanged.

## 6. Control a run

| Action | Behavior |
| --- | --- |
| Pause | `delivery_pause` stops scheduling after the current step; durable state is kept |
| Resume | `delivery_resume` resumes a paused, queued, or blocked run; blocked tasks are retried within the attempt budget |
| Raise budgets | Pass only increases for `max_total_tokens`, `max_duration_hours`, or `max_task_attempts` on resume, or use **Apply to current run** on the run's Settings page |
| Cancel | `delivery_cancel` aborts running workers and marks unfinished tasks `CANCELLED`; it cannot be undone |

Budgets can only be increased. Decreasing a budget requires a new run. A run that exhausts `max_task_attempts`, `no_progress_cycles`, `max_dynamic_tasks`, `max_duration_hours`, or `max_total_tokens` becomes `BLOCKED`; inspect the decision, fix the underlying cause, then resume with a larger budget or start a new run.

## 7. Complete and finalize

When every mandatory acceptance condition has passing evidence at the accepted snapshot and every task is done or explicitly cancelled, the run becomes `COMPLETED`.

1. `delivery_export_report` writes `reports/final.md` into the run directory.
2. Review the integration worktree, `delivery.patch`, evidence, review findings, and residual risks.
3. Decide whether to finalize. The default is to keep the patch for a normal pull request.

`delivery_finalize` modes:

| Mode | Effect |
| --- | --- |
| `prepare-only` | Produce the integration worktree and `delivery.patch`; do not touch the main checkout |
| `commit` | Create a local commit parked on `refs/delivery/<run-id>` |
| `branch` | Create a delivery branch and commit |
| `push` | Push the confirmed branch |
| `merge` | Reserved for a project-specific finalizer; the generic finalizer refuses it |

The `confirmation` argument must be exactly `<run-id>:<mode>`; a bare run id is rejected. Finalization commits disable repository hooks, signing, and the file-system monitor so worker-delivered content is not executed on the host. Reaching `COMPLETED` never triggers a Git action by itself.

## Tool reference

| Tool | Key arguments |
| --- | --- |
| `delivery_start` | `prepared_directory`, `repo_root?`, `run_id?`, `config_override?`, `allow_trusted_host?` |
| `delivery_status` | `run_id?` (omit to list runs in the repository), `repo_root?` |
| `delivery_inspect` | `run_id`, `repo_root?` |
| `delivery_watch` | `run_id`, `repo_root?`, `timeout_ms?` (1–300000, default 30000) |
| `delivery_respond` | `run_id`, `decision_id`, `response`, `repo_root?` |
| `delivery_pause` | `run_id`, `repo_root?` |
| `delivery_resume` | `run_id`, `repo_root?`, `max_total_tokens?`, `max_duration_hours?`, `max_task_attempts?` |
| `delivery_cancel` | `run_id`, `repo_root?` |
| `delivery_export_report` | `run_id`, `repo_root?` |
| `delivery_finalize` | `run_id`, `mode`, `confirmation`, `repo_root?` |

Omitting `repo_root` resolves the session working directory or the run registry. Pass it explicitly when the session is not in the repository.

## Recipes

**A delivery blocked on a budget**

```text
delivery_status(run_id)
```

Read the blocking decision, confirm the budget increase with the user, then:

```text
delivery_resume(run_id, max_total_tokens: 4000000)
```

**A manual acceptance condition**

The run waits in `WAITING_HUMAN`. Verify the behavior yourself, then answer the decision. If it fails, answer with the failure; the controller creates an `acceptance_gap` repair task.

**A run that will be merged outside the plugin**

Leave the mode at `prepare-only`, export the report, and apply `delivery.patch` in your normal review flow. This is the recommended default for shared repositories.

**Preview the view without a real run**

```bash
npm run demo:view
```

This creates a synthetic completed run in a temporary Git repository. Delete the printed directory and its `~/.delivery-loop/runs.json` entry when done.

## Further reading

- [Configuration](configuration.md) — all fields and precedence
- [Operations](operations.md) — recovery, retention, and multi-run operation
- [Troubleshooting](troubleshooting.md) — symptom-based diagnosis
