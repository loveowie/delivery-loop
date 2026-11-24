# Intake checklist

## Inputs to capture

- repository root and the current baseline;
- the objective and the current behavior;
- the desired behavior, including edge cases;
- scope paths and explicit non-goals;
- compatibility constraints (APIs, schemas, migrations, configuration, user-visible behavior);
- acceptance conditions that prove the outcome;
- verification commands the controller can run independently;
- Git policy and finalization expectation;
- wall-clock and token budget;
- any domain-specific risk.

## Risk triggers

Ask for a decision before preparing the run when the work involves:

- a public API, data schema, migration, or stored data format;
- security, permissions, credentials, or trust boundaries;
- concurrency, ordering, idempotency, or recovery;
- performance or resource limits;
- external integrations or paid/provider behavior;
- a release, deployment, or Git history change;
- behavior that cannot be verified by a command.

## Blocking versus delegable

- **Blocking:** a missing product rule, acceptance ambiguity, a compliance or security constraint, or a choice only the user can make.
- **Delegable:** an implementation detail, file layout, refactor strategy, or test structure that the planner and workers can decide.

Do not convert an unresolved assumption into an implementation task.

## Approval summary

Before starting the run, show the user a compact summary:

```text
Goal:            <one sentence>
Scope:           <paths and behavior>
Non-goals:       <what is explicitly out>
Acceptance:      <mandatory conditions and how each is checked>
Verification:    <commands and backend>
Review:          <policy and final review>
Git:             <finalization mode, prepare-only by default>
Budget:          <tokens, duration, attempts>
Risks:           <known risks>
```

Wait for explicit approval. This is the only routine approval gate; later questions are raised by the controller as decisions.
