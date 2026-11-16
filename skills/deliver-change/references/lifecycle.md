# Lifecycle

Delivery states are `DRAFT`, `SPEC_READY`, `QUEUED`, `PLANNING`, `RUNNING`, `VERIFYING`, `WAITING_HUMAN`, `BLOCKED`, `PAUSED`, `COMPLETED` and `CANCELLED`.

A task is complete only after its patch is integrated into the integration worktree and all affected verification evidence is valid for the resulting code snapshot. Worker-reported completion is only an input.

New tasks must originate from a test failure, review finding, acceptance gap, explicit user change or approved plan.
