# Verification report

Date: 2026-11-17 (Asia/Shanghai)
Environment: macOS, DeepSeek Harness Desktop 0.2.2-rc.3, Node 24.

## Automated checks

| Check | Result |
| --- | --- |
| `npm test` | 199/199 passed (final count is rechecked by `npm run verify:release`) |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `npm run verify:skills` | 10 vendored Skills verified |
| DSH bundle activation | `include:delivery-loop` active |
| Native tools | all 10 `delivery_*` tools visible |
| Skill catalog | `deliver-change` listed |
| Client slots | dock, overlay, settings section and all 10 tool-view keys active |
| View API | health/runs/run/file/diff verified; unauthenticated requests return 401 |
| Package layout | Host/Client halves, locale, icon, schemas and patch present; legacy paths absent |

## Live native delivery run

A real DSH-hosted run was executed in a temporary Git repository:

| Field | Value |
| --- | --- |
| Run id | `R-DSH-NATIVE-2` |
| Status | `COMPLETED` |
| Progress | 1/1 |
| Worker | fresh DSH subagent via `ctx.subagents` (`spawn`) |
| Task | create `src/hello2.ts` with a `hello2` function |
| Verification | `test -f src/hello2.ts` passed |
| Integration | `SNAP-aff48c438694` |
| Token usage | 146,848 |
| `usage_incomplete` | false |
| Decisions | 8: run_started, task_started, worker_completed, verification_passed, integration_passed, task_done, final_verification_passed, acceptance_passed |
| Errors / pending decisions | none |

The worker used the DSH file/shell tools, followed the task contract, produced `src/hello2.ts` and a test, and returned a validated `AgentResult` through `structured_output`.

## View verification

The run is visible in **Settings → 交付循环** with its title, status, progress, token usage, task, decisions, changed files, artifacts and completion reference. HTTP responses for the same run were checked directly. The browser page's rendered layout, light/dark appearance, focus behavior and narrow-width layout were not visually verified because no browser control was available; refresh the page after installing or upgrading the client.

## Not verified

- real container isolation (no container runtime on this host);
- provider quota/paid protocol failures;
- a real Host restart with the coordinator fallback;
- a reviewer/acceptance task that attempts a write (the snapshot check is covered by controller tests, not OS isolation);
- Windows.
