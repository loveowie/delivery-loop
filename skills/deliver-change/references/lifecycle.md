# Lifecycle

Delivery states are `DRAFT`, `SPEC_READY`, `QUEUED`, `PLANNING`, `RUNNING`, `VERIFYING`, `WAITING_HUMAN`, `BLOCKED`, `PAUSED`, `COMPLETED` and `CANCELLED`.

A task is complete only after its patch is integrated into the integration worktree. Task verification commands are re-run at the final integrated snapshot, so earlier task evidence is not silently accepted as current. Worker-reported completion is only an input.

A run is not completable if a requirement has neither a mandatory acceptance condition nor a covering task verification command; the graph is rejected at start.

Manual rejection creates an `acceptance_gap` repair task. Repeated failures are bounded by `max_task_attempts` and `max_dynamic_tasks`; an exhausted budget becomes `BLOCKED` and requires an explicit resume with raised budgets or a new run.

New tasks must originate from a test failure, review finding, acceptance gap, explicit user change or approved plan.
