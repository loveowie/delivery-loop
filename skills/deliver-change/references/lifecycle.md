# Lifecycle

## Run status

| Status | Meaning |
| --- | --- |
| `DRAFT` | Prepared input is being assembled |
| `SPEC_READY` | The prepared contract is complete but not started |
| `QUEUED` | Admitted; waiting for a repository write slot or the controller loop |
| `PLANNING` | The controller is preparing the first tasks |
| `RUNNING` | Tasks are executing |
| `VERIFYING` | The controller is verifying tasks or evaluating acceptance |
| `WAITING_HUMAN` | A pending decision needs an answer |
| `BLOCKED` | A budget, environment, or recovery limit was reached |
| `PAUSED` | Scheduling stopped after the current step; state is kept |
| `COMPLETED` | Every mandatory acceptance condition passed at the accepted snapshot |
| `CANCELLED` | The run was cancelled; unfinished tasks are `CANCELLED` |

Terminal or waiting states are `COMPLETED`, `CANCELLED`, `BLOCKED`, `PAUSED`, and `WAITING_HUMAN`.

## Task completion

A task is complete only after its patch is integrated into the integration worktree. Task verification commands are re-run at the final integrated snapshot, so earlier task evidence is not silently accepted as current. A worker-reported completion is only an input.

A run is not completable if a requirement has neither a mandatory acceptance condition nor a covering task verification command; the graph is rejected at start.

## Repair tasks and budgets

Manual rejection creates an `acceptance_gap` repair task. Test failures, review findings, scope violations, and required-output gaps create repair tasks with the matching origin.

Repeated failures are bounded by `max_task_attempts` and `max_dynamic_tasks`. An exhausted budget becomes `BLOCKED` and requires an explicit resume with raised budgets or a new run. A failure fingerprint that repeats without a change stops unchanged retries.

New tasks must originate from a test failure, a review finding, an acceptance gap, an explicit user change, or an approved plan. Do not invent unrelated work mid-run.

## Human gates

- **Approval gate:** scope, acceptance, and verification policy are approved once, before `delivery_start`.
- **Finalization gate:** no Git action happens until the user selects a mode and the call carries `<run-id>:<mode>`.

Everything between the gates is autonomous; questions arrive as controller decisions, not worker questions.
