# Worker Contracts

Workers receive a bounded objective, requirement and acceptance IDs, allowed paths, context files, verification commands, timeout and resolved Skill paths. They return structured results with files changed, commands run, review findings, risks, suggested tasks and blockers.

Workers must not ask the user directly, create nested delivery runs, commit or push. Any human decision must be returned as a blocker so the controller can enter `WAITING_HUMAN`.
