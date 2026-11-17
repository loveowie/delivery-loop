# Evaluation

Delivery Loop is exercised at three levels.

## 1. Unit and integration tests

```bash
npm test
```

The suite covers the scheduler, task state machine, controller, acceptance, required outputs, review cycle, evidence ledger, state store, config, Git adapter, worktree manager, patch integrator, finalizer, report writer, DSH worker adapter, and view service. Real-Git tests create temporary repositories, worktrees, snapshots and patches.

## 2. Static and composition checks

```bash
npm run typecheck
npm run build
npm run verify:skills
npm run verify:release
```

`verify:release` regenerates schemas, runs typecheck/build/skills/tests, packages the DSH bundle, rejects legacy paths, and checks the packed Host and Client entries.

## 3. Live DSH delivery

A live smoke starts a prepared run from a DSH agent session and waits for completion:

1. create a temporary Git repository with `spec.md`, `task-graph.json` and a `delivery.yaml` using `verification.execution.backend: trusted-host`;
2. call `delivery_start` with a run id and `allow_trusted_host: true` after explicitly approving host execution;
3. let DSH subagent workers implement the task;
4. confirm verification, integration and acceptance;
5. inspect `run.json`, `completion.json`, the decision log and the worktree.

The latest completed run, including measured token usage, is recorded in [the verification report](verification-report.md).

## What the live smoke does not cover

- real container isolation (no container runtime on the verification host);
- paid/provider-specific protocol failures and quota limits;
- multiprocess crash/fencing and a real Host restart;
- a reviewer/acceptance task mutating files (the controller rejects this by snapshot comparison, but it is not an OS sandbox);
- rendered browser layout, light/dark appearance, focus behavior, and narrow-width layout.

Passing tests do not certify production reliability. Treat the limits in the README and verification report as release gates.
