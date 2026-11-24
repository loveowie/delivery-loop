# Troubleshooting a delivery

| Symptom | Action |
| --- | --- |
| Required skill hash fails | Stop and report the mismatch; do not run with unverified skill content |
| Verification needs the host shell | The user must explicitly approve `allow_trusted_host`; the repository `delivery.yaml` cannot enable it |
| A worker stalls or the Host restarts | Use `delivery_resume` or `delivery_status`; an orphaned `RUNNING` task is reset only when no worker lock owner exists |
| Tests fail repeatedly with the same fingerprint | Inspect the failure context and repair task; do not retry unchanged beyond the attempt budget |
| Integration or worktree preparation fails | Read the recorded decision; resume for a bounded retry, or start a new run after resolving the conflicting content |
| Budget or duration block | Resume with a larger `max_total_tokens`, `max_duration_hours`, or `max_task_attempts`; otherwise start a new run |
| Container verification blocks | The backend is fail-closed: install a digest-pinned image or select `trusted-host` in the prepared file with explicit approval |
| Run rejected at start | Fix the contract: coverage, unknown ids, profile mismatch, cycle, or a mandatory review without `final_review` |
| Run is `WAITING_HUMAN` | Read the exact decision, ask the user, then use `delivery_respond` |

Report only what the controller's state and evidence show. If the cause is unknown, collect the run id, the last decision, and the failing task's `failure_context` before retrying.
