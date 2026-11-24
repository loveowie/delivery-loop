# AGENTS.md

Instructions for AI coding agents working in this repository. Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md) instead; both documents describe the same rules.

## Read before changing code

1. [README.md](README.md) — what the plugin does.
2. [docs/architecture.md](docs/architecture.md) — components, lifecycle, recovery, and trust boundaries.
3. [docs/configuration.md](docs/configuration.md) — configuration layers and defaults.
4. [docs/testing.md](docs/testing.md) — how changes are verified.
5. [CONTRIBUTING.md](CONTRIBUTING.md) — design invariants and review expectations.

## Commands

```bash
npm ci
npm run build          # src/ -> dist/
npm test               # unit + integration
npm run typecheck
npm run verify:skills
npm run verify:release # full gate; run this before proposing a release
```

Do not run `npm run update:skills` unless you are intentionally syncing upstream vendored content. It rewrites `capabilities/skills.lock.yaml`; review the diff and keep the third-party notices accurate.

## Hard rules

- **Do not weaken verification.** No fallback from `container` to `trusted-host`, no acceptance from a worker's claim, no evidence from a different snapshot.
- **Do not bypass gates.** `delivery_finalize` keeps `<run-id>:<mode>` confirmation and `prepare-only` as the default. `trusted-host` stays opt-in in the prepared file plus `allow_trusted_host: true`.
- **Do not loosen budgets.** Attempt, duration, token, no-progress, and dynamic-task limits must block, not silently retry.
- **Do not hand-edit generated files.** `schemas/*.json` come from `npm run generate:schemas`; vendored skills come from the sync script.
- **Do not commit machine-local files.** No `.DS_Store`, `.idea/`, `dist/`, `node_modules/`, `.delivery/`, local run data, or absolute paths.
- **Do not claim a command passed** unless you ran it in this checkout and saw the exit code.

## Documentation rules

- README is bilingual. Change `README.md` and `README.zh-CN.md` together.
- Detailed guides live in `docs/` and describe released behavior. A design proposal is marked **Proposal** and says what is not implemented.
- Keep relative links valid; update [docs/README.md](docs/README.md) when adding or moving pages.
- Update `CHANGELOG.md` for user-visible changes.
- State limitations honestly. Do not describe unverified behavior as verified.

## Change checklist

- [ ] Behavior is covered by a test that fails without the change.
- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] Docs and changelog are updated for user-visible changes.
- [ ] Packaging is unchanged, or `npm pack --dry-run` was inspected.
- [ ] No secrets, local paths, or generated run data were added.

## Where things live

| Path | Purpose |
| --- | --- |
| `src/dsh/host.ts` | Plugin manifest surface: tools, skill, prompt, view API |
| `src/controller/` | Run factory, controller, acceptance, recovery |
| `src/runtime/` | Queue, run manager, locks, preflight |
| `src/workers/` | DSH subagent adapter and worker prompts |
| `src/workspace/` | Git, worktrees, snapshots, patches |
| `src/verification/` | Command runner and evidence |
| `skills/deliver-change/` | The bundled skill and its references |
| `capabilities/` | Vendored skills, profiles, lock file, license notices |
| `client.js` | Hand-maintained browser half |
| `tests/` | Mirrors `src/`, plus e2e and real-Git tests |

If a change intentionally alters a documented invariant, update the architecture document and the tests that encode it in the same change.
