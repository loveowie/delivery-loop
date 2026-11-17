# Troubleshooting

- If a required Skill hash fails, stop and report the mismatch.
- If verification needs the host shell, the user must explicitly approve `allow_trusted_host`; repository `delivery.yaml` cannot enable it.
- If a Worker stalls or the Host restarts, use `delivery_resume` / `delivery_status`; an orphaned `RUNNING` task is reset and rescheduled only when no worker lock owner exists.
- If tests fail repeatedly with the same fingerprint, inspect the failure context and repair task; do not retry unchanged beyond the attempt budget.
- If integration or worktree preparation fails, read the recorded decision and either resume (bounded retry) or start a new run after resolving the conflicting content.
- If a budget or duration block is reported, resume with a larger `max_total_tokens`, `max_duration_hours` or `max_task_attempts`; otherwise start a new run.
