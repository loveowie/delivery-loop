# Verification report — 0.2.0 development

> **Historical record.** This report describes the verification performed for the 0.2.0 development branch on the date below. It is not a live status page; commands, test counts, and limitations may have changed since. Current procedures are in [Testing](../testing.md).

Date: 2026-11-18 (Asia/Shanghai)
Environment: macOS, DeepSeek Harness Desktop 0.2.2-rc.3, Node 24.

## Automated checks

| Check | Result |
| --- | --- |
| `npm test` | 257/257 passed at that date |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `npm run verify:skills` | 10 vendored Skills verified |
| `npm run verify:release` | passed (schemas, typecheck, build, tests, skills, package layout) |
| DSH bundle activation | `include:delivery-loop` active |
| Native tools | all 10 `delivery_*` tools visible |
| Skill catalog | `deliver-change` listed |
| Client slots | sidebar panel row + main board, dock, overlay and all tool-view keys active |
| View API | health/runs/run/file/diff; unauthenticated requests return 401; DSH session cookie (Desktop forwards the Host cookie) is the primary credential, with the per-process token as fallback |
| Package layout | Host/Client halves, locale, icon, schemas and patch present; legacy paths absent |

## Live native delivery run — workflow hardening

A real DSH-hosted run exercised the workflow-hardening patch on this repository:

| Field | Value |
| --- | --- |
| Run id | `R-WF-GAP-20261117B` |
| Status | `COMPLETED` |
| Progress | 5/5 tasks |
| Baseline | `18f9fe7` |
| Integration snapshot | `SNAP-bee7f0121821` |
| Verification | 253 tests at the accepted snapshot; targeted acceptance commands; typecheck and build |
| Acceptance | 8/8 mandatory conditions with passing evidence at the accepted snapshot |
| Token usage | 53,752,414 |
| `usage_incomplete` | false |
| Independent review | all 5 task reviews passed; no blocking finding |
| Patch round-trip | `delivery.patch` applied to `18f9fe7` reproduces `SNAP-bee7f0121821`; sha256 matches |
| Errors / pending decisions | none; one review worker hit a transient DSH worker error and succeeded on retry |

The run covered: repair re-run required-outputs closure, blocker re-dispatch, resume/recovery attempt accounting, pause lifecycle, queue admission fencing, corrupt-run isolation, atomic run creation, final-review/human-acceptance/contract closure, bounded worker timeout with activation disposal, seed/patch/finalize provenance, and parent-Agent fallback.

The view/auth/sidebar-board changes were merged into the same branch after that run; the combined branch was re-verified by the 257-test suite and `verify:release` above.

## View verification

The delivery view was available as a **交付循环** sidebar board and a detail overlay (tasks, decisions, changed files, artifacts and events), plus the composer strip and compact tool cards. The view API's token injection used the structured `webserver/index-inject` row (so the Desktop boot payload received it) and browser-session authentication; the per-process token remained a fallback. Tests: `tests/dsh/host-view-token.test.ts`, `tests/dsh/client-registration.test.ts`.

The browser page's rendered layout, light/dark appearance, focus behavior and narrow-width layout were not visually verified because no browser control was available.

## Not verified

- The live run had `review.final_review` disabled because its controller predated the final-review fix; the fixed path is covered by tests, not by that live run.
- Real container isolation (no container runtime on this host).
- Provider quota and paid-protocol failures.
- A real Host restart with the coordinator fallback.
- A reviewer/acceptance task that attempts a write (the snapshot check is covered by controller tests, not OS isolation).
- `merge` finalization (still requires a project-specific finalizer).
- Windows.

## Reproducing

From the repository root at the recorded baseline:

```bash
npm ci
npm run verify:release
```

A live delivery requires a DSH session with the bundle enabled and a trusted temporary repository; see [Testing](../testing.md#4-live-dsh-delivery). The original run directory was local to the development machine and is not distributed with this repository.
