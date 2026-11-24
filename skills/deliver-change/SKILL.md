---
name: deliver-change
description: Run a generic end-to-end software delivery loop from an approved specification through implementation, verification, independent review, and acceptance. Use when the user explicitly wants autonomous delivery, multi-agent development, or a loop that continues until the work is verified and accepted.
---

# Deliver Change

Use this skill only for an explicitly requested end-to-end delivery. For a single small edit, one review, or plan-only work, use the normal DSH workflow instead.

## Workflow

1. **Intake.** Read the target repository's `AGENTS.md` and relevant project documentation, then read `references/intake.md`. Confirm the goal, scope, non-goals, acceptance conditions, verification strategy, Git policy, time and token budget, and any domain-specific risk. If a critical decision is missing, ask the user before creating a run.
2. **Prepare.** Create or validate `.delivery/prepared/<draft-id>/` with `spec.md`, `task-graph.json`, and optionally `delivery.yaml`. Use `references/lifecycle.md` for status semantics and `references/worker-contracts.md` for task fields. Do not turn unresolved assumptions into implementation tasks.
3. **Approve.** Show the user the final scope and acceptance summary and obtain explicit approval. This is the only routine approval gate for the autonomous loop.
4. **Start.** Call `delivery_start` with the repository root and prepared directory.
5. **Monitor.** Use `delivery_watch` to wait for meaningful progress; use `delivery_status` for a summary and `delivery_inspect` for the full graph, decisions, evidence, files, and artifacts. Do not poll in a tight loop.
6. **Decide.** When the run enters `WAITING_HUMAN`, explain the exact `decision_id`, question, and options, then call `delivery_respond` after the user answers.
7. **Complete.** Report only facts returned by the controller. Do not finalize without an explicit user choice.

## Prepared artifacts

```text
.delivery/prepared/<draft-id>/
├── spec.md
├── task-graph.json          # requirements, acceptance, tasks
└── delivery.yaml            # optional; overrides repository configuration
```

- The graph must be acyclic.
- Every requirement must be satisfiable: either a mandatory acceptance condition, or a covering task with at least one `verification_commands` entry. Otherwise `delivery_start` rejects the graph instead of starting a run that can only block at acceptance.
- Every task's `capability_profile` must match the run `profile`.
- Verification policy belongs in the prepared `delivery.yaml`. `delivery_start.config_override` is limited to runtime, review, Git, and worker overrides.
- Do not silently relax validation because a required skill, CLI, or environment is unavailable.

## Start options

Call `delivery_start` with:

- the repository root;
- the prepared specification directory;
- optional runtime, review, Git, or worker overrides;
- `allow_trusted_host: true` only after the user explicitly approves host-shell verification.

A repository-level `delivery.yaml` cannot enable `trusted-host`; only the approved prepared file can select it.

## Human decisions

A blocked worker or a manual acceptance condition produces a pending decision. Read its exact `decision_id` and options from `delivery_status`, then call `delivery_respond`. Rejecting a manual acceptance condition creates an acceptance-repair task and resumes the controller; it does not leave the run waiting unchanged.

`delivery_resume` can raise `max_total_tokens`, `max_duration_hours`, or `max_task_attempts` after explicit user confirmation. A blocked worker, scope violation, integration conflict, or exhausted budget must be surfaced with its decision; do not silently restart the run.

## Completion and finalization

Read `references/verification.md` and report:

- completion, blocked, or cancellation state;
- requirement and acceptance traceability;
- files changed;
- verification commands and results;
- review findings and their status;
- residual risks;
- integration worktree and `delivery.patch` path;
- operations that were not performed.

Do not call `delivery_finalize` unless the user explicitly selects a finalization mode. The `confirmation` argument must be exactly `<run-id>:<mode>`. Default delivery is `prepare-only`: no commit, push, merge, or deployment.

## Boundaries

- Never start a nested `deliver-change` run from inside a worker.
- Do not treat a worker's completion message as proof.
- Do not require OpenSpec or a business-domain skill for the portable profile.
- Never let repository content enable trusted-host verification.
- Do not report a command as passed unless the controller's evidence shows it.

## References

| File | Use |
| --- | --- |
| `references/intake.md` | Questions and risk triggers for intake |
| `references/lifecycle.md` | Run and task status semantics, repair and budgets |
| `references/verification.md` | Evidence rules and completion gate |
| `references/worker-contracts.md` | What a worker receives and may do |
| `references/troubleshooting.md` | Recovering a stalled or failing run |
