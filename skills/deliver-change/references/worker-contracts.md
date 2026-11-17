# Worker Contracts

Workers receive a bounded objective, requirement and acceptance IDs, allowed paths, context files, verification commands, timeout, resolved Skill paths, frozen decisions and baseline failures. They return structured results with files changed, commands run, review findings, risks, suggested tasks and blockers.

A task is not accepted merely because a worker says it is done: the controller re-runs task and acceptance checks at the final integrated snapshot. A worker that returns `blocked` without blockers still produces an answerable human decision; a worker that cannot prove its work with a command must be covered by a mandatory acceptance condition instead.

Workers must not ask the user directly, create nested delivery runs, commit or push. Any human decision must be returned as a blocker so the controller can enter `WAITING_HUMAN`.
