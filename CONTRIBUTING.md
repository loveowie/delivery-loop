# Contributing to Delivery Loop

Thanks for taking the time to contribute. This guide covers the development environment, the design invariants this project protects, and what a good pull request looks like.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — use the bug report form. Include the plugin version, DSH version, OS, run id, and the exact error.
- **Request a feature** — use the feature request form. Explain the delivery problem, not only the proposed mechanism.
- **Improve documentation** — typo fixes, clearer examples, and missing troubleshooting entries are valuable.
- **Send code** — bug fixes, tests, and well-scoped features. Open an issue first for a large change so the design can be agreed before implementation.

Security issues must follow [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Requirements: Node.js 24+, Git, and npm.

```bash
git clone https://github.com/loveowie/delivery-loop.git
cd delivery-loop
npm ci
npm run build
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm test` | Unit and integration tests |
| `npm run test:watch` | Watch mode |
| `npm run typecheck` | TypeScript checks with the test config |
| `npm run build` | Compile `src/` to `dist/` |
| `npm run generate:schemas` | Regenerate `schemas/*.json` from the Zod domain schemas |
| `npm run verify:skills` | Check vendored skill hashes |
| `npm run update:skills` | Sync vendored skills and rewrite the lock (review the diff) |
| `npm run verify:release` | Full release gate |
| `npm run demo:view` | Create a synthetic completed run for the view |

To try the plugin in DSH, build the checkout and install the directory as a local bundle. Restart the Desktop app after changing the Host half; reload the page after changing `client.js`.

## Repository layout

```text
src/
├── capabilities/   skill resolution and hashing
├── config/         configuration loading, validation, runtime settings
├── controller/     run factory, controller, scheduler-facing lifecycle, acceptance, recovery
├── domain/         types, Zod schemas, delivery contract validation
├── dsh/            Host plugin registration and the view service
├── finalize/       Git finalization modes
├── reporting/      run report writer
├── runtime/        queue, run manager, locks, preflight, process supervision
├── scheduler/      ready-task scheduling and state machine
├── service/        tool-facing delivery service and settings service
├── state/          atomic run state and the evidence ledger
├── verification/   command runner and evidence store
├── workers/        DSH subagent adapter, fake adapter, worker prompts
└── workspace/      Git adapter, worktrees, repository context, patch integration

tests/              mirrors src/ plus e2e/, workspace/, workers/, dsh/
capabilities/       vendored skills, profiles, role-skills, lock file, third-party notices
skills/             the bundled deliver-change skill and its references
schemas/            generated JSON schemas (do not hand-edit)
docs/               user, operator, and contributor documentation
examples/           a prepared portable delivery
client.js           hand-maintained DSH browser half
```

## Design invariants

These are not style preferences; changing one changes the product's trust story.

- **The controller decides; workers only do.** Verification, review, integration, and acceptance stay in the controller. Do not let a worker result transition a task to `DONE`.
- **Evidence is snapshot-bound.** Never accept evidence from a different code snapshot. Integration invalidates older evidence, and the final matrix re-runs completed tasks' commands.
- **Failures become tasks or blocks.** Do not add a silent retry that bypasses attempt, duration, token, or no-progress budgets.
- **Verification is fail-closed.** A missing container runtime, image, or digest is an error that blocks the run; it must not fall back to host execution.
- **`trusted-host` is opt-in and approved.** It cannot be enabled by a repository-level file, and `delivery_start` requires explicit confirmation.
- **Finalization is explicit.** No Git action happens on `COMPLETED`. `confirmation` is exactly `<run-id>:<mode>`; `prepare-only` is the default; `merge` is refused without a project-specific finalizer.
- **State is durable and revision-guarded.** Writes are atomic, locks are respected, and recovery must consume an attempt rather than resetting budgets.
- **The view is read-only except for the documented actions.** It reads only the run's repository, worktrees, and `.delivery` artifacts; it rejects symlink escapes and never creates state just to list runs.

If a change intentionally alters one of these, say so in the pull request and update [Architecture](docs/architecture.md) and the tests that encode it.

## Code style

- TypeScript, ES modules, `strict` mode, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- No new runtime dependency without a clear need; the runtime currently depends on `zod`, `yaml`, and `proper-lockfile`.
- Keep files focused. Prefer a small pure function plus a test over a new abstraction.
- Comments explain why a constraint exists, not what the next line does.
- Use the existing error vocabulary and decision types; do not invent a parallel status system.
- Never log secrets, tokens, or full environments.

## Tests

- Add a regression test for every bug fix.
- Use the real-Git fixtures when behavior depends on Git; do not mock what you are trying to prove.
- Keep tests deterministic: no network, no wall-clock sleeps, no dependency on global Git configuration.
- For DSH integration, follow the existing fake-host patterns in `tests/dsh/` and `tests/workers/`.
- Run `npm run verify:release` before requesting review when you change runtime behavior, schemas, packaging, or vendored skills.

See [Testing](docs/testing.md) for the full matrix and the known gaps.

## Documentation

- README is bilingual: update both `README.md` and `README.zh-CN.md` when user-facing behavior changes.
- Detailed guides are English under `docs/`. Keep them in the present tense and describe released behavior, not aspirations.
- A design proposal is marked **Proposal** and must state what is not implemented.
- Keep links relative and valid. Update the [documentation index](docs/README.md) when you add or move a page.
- Commands in docs must actually run. Prefer copy-pasteable examples with realistic placeholders.
- Update `CHANGELOG.md` for user-visible changes.

## Commit messages and pull requests

Use Conventional Commits for the subject:

```text
feat(view): add a repository filter to the board
fix(worker): recover from the inactive-context teardown race
docs(config): document the settings precedence
test(controller): cover acceptance rejection with a repair task
```

A pull request should:

- describe the problem and the chosen behavior;
- list the user-visible changes and any compatibility impact;
- name the tests added or updated, and the commands you ran;
- update docs and the changelog when behavior changes;
- keep unrelated refactors out of the same change.

Small, reviewable commits are easier to accept than one large mixed change. Do not force-push a branch under review unless asked.

## Licensing

Delivery Loop is released under the [MIT License](LICENSE). By contributing, you agree that your contribution is licensed under the same terms (inbound = outbound). No separate contributor license agreement is required. Only contribute code, text, or artwork you have the right to license this way; vendored third-party content must keep its license and be recorded in `capabilities/skills.lock.yaml` and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Release process

Maintainers follow [Publishing](docs/publishing.md). Release candidates must pass `npm run verify:release` and the manual checks listed there.

## Getting help

- Open a discussion or issue for design questions.
- For a suspected vulnerability, use the private channel in [SECURITY.md](SECURITY.md).
- For conduct concerns, follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
