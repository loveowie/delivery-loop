---
name: deliver-change
description: Run a generic end-to-end software delivery loop from an approved specification through implementation, verification, independent review, and acceptance. Use when the user explicitly wants autonomous delivery, multi-agent development, or a loop that continues until the work is verified and accepted.
---

# Deliver Change

Use this Skill only for an explicitly requested end-to-end delivery. For a single small edit, one review, or plan-only work, use the normal Codex workflow instead.

## Intake

1. Read the target repository's `AGENTS.md` and relevant project documentation.
2. Read `references/intake.md`.
3. Confirm the goal, scope, non-goals, acceptance conditions, verification strategy, Git policy, time/token budget and any domain-specific risk.
4. If a critical decision is missing, ask the user before creating a run.

## Prepare the approved run

Create or validate these files under `.delivery/prepared/<draft-id>/`:

- `spec.md`
- `requirements.json`
- `task-graph.json`
- `delivery.yaml` or use the repository-level configuration

Use `references/lifecycle.md` for status semantics and `references/worker-contracts.md` for task fields. Do not turn unresolved assumptions into implementation tasks.

Before starting the run, show the user the final scope and acceptance summary and obtain explicit approval. This is the only routine approval gate for the autonomous delivery loop.

## Start and monitor

Call `delivery_start` with:

- the repository root;
- the prepared specification directory;
- optional configuration overrides.

Then use `delivery_watch` to wait for meaningful progress. Use `delivery_status` for an on-demand summary. Do not repeatedly poll in a tight loop.

When the run enters `WAITING_HUMAN`, call `delivery_status`, explain the exact `decision_id`, and use `delivery_respond` after receiving a user answer.

## Completion

Read `references/verification.md` and report only the facts returned by the controller:

- completion, blocked or cancellation state;
- Requirement and Acceptance traceability;
- files changed;
- verification commands and results;
- review findings and their status;
- residual risks;
- integration worktree and `delivery.patch` path;
- operations that were not performed.

Do not call `delivery_finalize` unless the user explicitly selects a finalization mode and confirms the exact run ID. Default delivery is `prepare-only`: no commit, push, merge or deployment.

## Boundaries

- Never start a nested `deliver-change` run from inside a Worker.
- Do not treat a Worker's completion message as proof.
- Do not require OpenSpec or a business-domain Skill for the portable profile.
- Do not silently relax validation because a required Skill, CLI or environment is unavailable.
