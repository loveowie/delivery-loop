## Summary

<!-- What problem does this change solve, and what behavior changes? -->

## Changes

<!-- Bullet the user-visible and internal changes. -->

-

## Verification

<!-- Commands you ran and their results. Do not claim a check you did not run. -->

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run verify:release` (required for runtime, schema, packaging, or vendored-skill changes)

## Compatibility and security

<!-- Does this change run state, configuration, tool contracts, verification, permissions, or finalization? -->

- Run-state / config compatibility:
- Verification or permission impact:
- DSH version range impact:

## Documentation

- [ ] README updated (`README.md` and `README.zh-CN.md`) if user-facing
- [ ] `docs/` updated and links checked
- [ ] `CHANGELOG.md` updated for user-visible changes
- [ ] Design proposal marked as **Proposal** if it describes unimplemented behavior

## Checklist

- [ ] The change is focused and does not mix unrelated refactors
- [ ] A regression test covers the behavior, or the reason it cannot be tested is stated
- [ ] No secrets, local paths, generated run data, or machine-local files are included
- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md)
