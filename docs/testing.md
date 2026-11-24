# Testing

Delivery Loop is tested at four levels: unit and integration tests, static checks, a packed-package check, and a live DSH-hosted delivery. No single level certifies production reliability; the gaps are listed at the end.

## Commands

```bash
npm ci
npm test            # unit and integration tests
npm run typecheck   # tsc with the test config
npm run build       # compile src/ to dist/
npm run verify:skills
npm run verify:release
```

`verify:release` is the release gate. It:

1. regenerates schemas and fails if the committed files are stale;
2. runs typecheck and build;
3. verifies vendored skills against `capabilities/skills.lock.yaml`;
4. runs the test suite;
5. packs the package and checks the required files, forbidden legacy paths, machine-local files, and the syntax of the Host and Client entry points.

## 1. Unit and integration tests

`npm test` runs Node's test runner through `tsx`. The suite covers:

| Area | Notable coverage |
| --- | --- |
| Configuration | defaults, merge precedence, repository restrictions, settings files |
| Contracts | graph validation, requirement satisfaction, acceptance evaluation, review gates |
| Controller | task lifecycle, repair tasks, retries, acceptance loop, review closure, reliability |
| Scheduler | readiness, priority, scope exclusion, worker capacity, state machine |
| Runtime | queue admission and fencing, recovery, worker locks, preflight, run factory |
| State and evidence | atomic writes, revisions, locks, corruption handling, evidence ledger |
| Verification | command runner, environment filtering, redaction, exit codes |
| Workspace | Git adapter, worktree manager, snapshots, patch integration and round-trips |
| Workers | subagent adapter (fake host), timeouts, process supervision |
| Finalization | modes, provenance, refusal of unsupported modes |
| DSH integration | manifest, client registration, view token, view service, settings API |
| Reporting | report writer |

Real-Git tests create temporary repositories, worktrees, snapshots, and patches instead of mocking Git. Tests that need a controller inject an in-process one to keep feedback deterministic.

### Integration suite

The heavier process and real-Git tests can be run separately:

```bash
npm run test:integration
```

It includes end-to-end reliability tests, real-Git workspace tests, and process-level worker tests.

## 2. Static and composition checks

```bash
npm run typecheck
npm run build
npm run verify:skills
```

- TypeScript runs in strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- `verify:skills` checks every vendored `SKILL.md` and resource hash against `capabilities/skills.lock.yaml`. Regenerate with `npm run update:skills` only when intentionally syncing upstream content.
- Schemas under `schemas/` are generated from the Zod domain schemas with `npm run generate:schemas`; do not hand-edit them.

## 3. Packed-package check

`npm run verify:release` runs `npm pack` and inspects the result. It requires the Host and Client entries, locales, icon, schemas, and skill lock, and rejects legacy paths and machine-local files. This catches packaging mistakes that unit tests cannot see.

## 4. Live DSH delivery

A live smoke starts a prepared run from a DSH agent session and waits for completion:

1. create a temporary Git repository with `spec.md`, `task-graph.json`, and a `delivery.yaml` using `verification.execution.backend: trusted-host`;
2. call `delivery_start` with the prepared directory and `allow_trusted_host: true` after explicitly approving host execution;
3. let DSH subagent workers implement the task;
4. confirm verification, integration, and acceptance;
5. inspect `run.json`, `completion.json`, the decision log, evidence, and the worktree.

A completed live run is recorded in the [0.2.0 verification report](reports/2026-11-18-verification.md), including measured token usage and the accepted snapshot.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests against Ubuntu and macOS with Node 24:

```text
npm ci --ignore-scripts
npm run verify:release
npm audit --omit=dev --registry=https://registry.npmjs.org
```

CI does not run a live DSH-hosted delivery, a real container boundary, or a browser render.

## What is not covered

These gaps are release risks, not test bugs:

- real container isolation (the verification host has no container runtime);
- provider-specific protocol failures, quotas, and billing limits;
- multiprocess crash and fencing drills, and a real Host restart with the coordinator fallback;
- a reviewer or acceptance task that attempts to write (the controller's snapshot check is tested, but it is not an OS sandbox);
- rendered browser layout, light/dark appearance, focus behavior, and narrow-width layout;
- the `merge` finalization path (it requires a project-specific finalizer);
- Windows.

## Adding tests

- Put unit tests next to the area they cover under `tests/<area>/`.
- Use the existing real-Git fixtures rather than mocking Git when the behavior depends on Git.
- For a bug fix, add a regression test that fails before the fix.
- Keep tests deterministic: no wall-clock sleeps, no network, and no dependency on a developer's global Git configuration.
- Run `npm run verify:release` before opening a pull request that changes runtime behavior, schemas, packaging, or vendored skills.

## Related documents

- [Contributing](../CONTRIBUTING.md) — development setup and review expectations
- [Architecture](architecture.md) — what the tests are protecting
- [Verification report](reports/2026-11-18-verification.md) — historical evidence
- [Publishing](publishing.md) — release checklist
