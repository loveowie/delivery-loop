# Verification isolation (proposal)

> **Status: proposal — not implemented in 0.2.0.**
>
> This document records a design direction, not shipped behavior. The released plugin has two
> verification backends (`container` and `trusted-host`), verifies against the worker's worktree
> for `trusted-host`, and does not implement `os-sandbox`, snapshot-derived input, two-phase
> preparation, or capability requirements. Decisions below were reviewed when the proposal was
> written; they may change before implementation.
>
> The current behavior is documented in [Configuration](../configuration.md#verification) and
> [Architecture](../architecture.md#trust-boundaries).

Scope: `verification.execution` backends, verification evidence, and the trust boundary around
`delivery_controller`'s verification step.
Related: [architecture](../architecture.md), [configuration](../configuration.md),
[operations](../operations.md), [testing](../testing.md).

## 0. Decisions at a glance

1. Verification input is always a **snapshot export**, never the worker's worktree — for every
   backend.
2. Add **`os-sandbox`**, a backend built on DSH's `ctx.sandbox` seam, so a Mac or Linux machine
   without a container runtime can still run verified deliveries.
3. Backends **declare capabilities**, runs **declare requirements**, and a mismatch fails closed at
   `delivery_start` instead of degrading silently.
4. Move dependency installation into a **prepare phase**, so the verify phase can run offline
   without a container image.
5. `container` stays the schema default; `os-sandbox` is a deliberate opt-in (decisions in §14).

## 1. Problem

The controller does not trust a worker's claim that tests pass: it re-runs the task's
verification commands itself and binds the result to a code snapshot. That independence is only
as strong as the environment the command runs in.

Today the environment is chosen by one enum with two values:

```ts
// src/domain/types.ts
export interface VerificationExecution {
  backend: 'container' | 'trusted-host';
  image?: string;
  command?: string;
}
```

`container` is fail-closed and reproducible, but requires a container runtime and a digest-pinned
image that already contains the project toolchain. `trusted-host` runs `/bin/sh -c` directly in
the task worktree with a filtered environment and a temporary `HOME`.

Two consequences follow:

1. **The default is unusable on a normal developer Mac.** No container runtime means every run
   blocks at its first verification command ([troubleshooting](../troubleshooting.md#verification-blocks-with-a-container-error)
   already documents this).
2. **`trusted-host` verifies the wrong tree.** It runs in the worktree the worker just edited, so a
   worker can poison `node_modules`, cache directories, or the test files themselves and the re-run
   still passes. The sandbox question is secondary; the *input* is wrong.

## 2. Threat model

Verification is trusted only for what it can actually establish. The threats, and what addresses
each one:

| ID | Threat | Addressed by |
| --- | --- | --- |
| T1 | Worker edits tests / hard-codes success | clean snapshot input; commands come from the graph, not the worker |
| T2 | Worker poisons `node_modules`, `PATH`, caches | clean snapshot input; filtered env; prepared env cache keyed by dependency digest (P2; P0 records `deps_source: 'worktree'` and leaves this gap open) |
| T3 | Verification command writes outside the task tree | write fence (container or OS sandbox) |
| T4 | Verification command reads host credentials (`~/.ssh`, `~/.aws`) | read fence (container only; OS sandboxes do not provide it) |
| T5 | Malicious code escapes to the host kernel | VM / container only |
| T6 | Environment drift ("passes only on my machine") | digest-pinned image (container) or dependency-digest env cache (`os-sandbox`) |

No single mechanism covers all six. The design therefore makes the guarantees **explicit and
per-run**, instead of pretending an OS sandbox is equivalent to a container.

## 3. Why this order

P0 first, because it changes the *input* and therefore the meaning of every existing backend's
result; doing it after P1 would mean re-interpreting evidence that was never about the snapshot.
P1 next, because it is the smallest change that makes a real delivery runnable on a laptop. P2
last, because it only strengthens an already-correct verdict (reproducibility), and its cache
format benefits from being designed after the evidence facts exist.

```text
prepare (network allowed)      verify (no network)              judge (controller)
  install deps into cache  ->  run commands against snapshot  ->  classify + bind evidence
  key = dep digest              read-only cache, writable tmp      to snapshot id
```

## 4. Backends and capabilities

```ts
export type VerificationBackend = 'container' | 'os-sandbox' | 'trusted-host';

export interface BackendCapabilities {
  writeFence: 'full' | 'partial' | 'none';   // can it stop writes outside the copy?
  readFence: 'full' | 'partial' | 'none';    // can it stop reads of host data?
  network: 'deny' | 'allowlist' | 'open';    // what it does about egress
  reproducibleEnv: boolean;                  // is the environment pinned by digest?
  enforcement: 'full' | 'partial';           // how completely the backend keeps its promises
}
```

| | write fence | read fence | network | reproducible env | zero install |
| --- | --- | --- | --- | --- | --- |
| `container` | full | full | deny | yes (image digest) | no |
| `os-sandbox` | full (macOS/Linux), partial (Windows) | none | open (no fence until DSH's policy gains one) | lockfile digest only | yes |
| `trusted-host` | none | none | open | no | yes |

`os-sandbox` maps onto the DSH seam as:

```ts
const policy: SandboxPolicy = {
  mode: 'workspace-write',            // read-only grants nothing; we need build output
  workspaceRoot: copyDir,             // the disposable snapshot export
  sessionId: initiatingSessionId,     // optional; per-session temp on Windows
};
const confined = await sandbox.confine(['/bin/sh', '-c', command], policy);
// spawn confined.argv[0] with the remaining argv; cwd = copyDir
```

`workspace-write` already grants `/tmp` and `os.tmpdir()`, which is what build caches need. The
copy is the only project path writable, and it is deleted after the run.

"Zero install" holds because DSH ships the Linux `landlock-run` launcher: bwrap is preferred when
present, but a kernel with Landlock (5.13+) works without installing anything.

**Windows is `partial`** in the ACL backend (hard links alias granted files, reads stay
unconfined). A run that requires `enforcement: full` must therefore reject `os-sandbox` on
Windows rather than silently accept it.

Residual risks accepted for `os-sandbox`, all properties of the same-world seam rather than bugs
to patch in the plugin: the host `/tmp` and `os.tmpdir()` stay writable, reads stay unconfined, and
the host kernel is shared.

## 5. Requirements and matching

Requirements live in the approved configuration and are checked twice: at `delivery_start`
(refuse to start) and per command (defense in depth, in case a backend's probe result changes).

```yaml
verification:
  execution:
    backend: os-sandbox
    fail_if_unavailable: true        # default; mirrors the seam's fail-closed contract
  requirements:
    write_fence: required            # required | best-effort | any
    read_fence: best-effort
    network: any                     # denied | allowlist | any
    reproducible_env: best-effort
    enforcement: required            # required rejects partial backends
```

The `requirements` values shown are the defaults (§14.2); only `execution.backend` has to be
chosen explicitly.

Matching rules:

- `required`: the capability must be present at full strength; otherwise `delivery_start` fails
  with a decision naming the missing capability and the backends that provide it.
- `best-effort`: allowed, but the evidence records the actual value and the view marks the run.
- `any`: ignored.

Two hard rules, mirroring the existing `trusted-host` guard in `src/config/config.ts`:

1. A repository-level `delivery.yaml` may never *weaken* requirements or select `trusted-host`.
   Only the prepared spec (approved by the user) may.
2. `delivery_start`'s `config_override` still cannot touch `verification`; the allow-list in
   `src/dsh/host.ts` (`SAFE_OVERRIDE_KEYS`) stays as is.

## 6. Snapshot-derived input (P0)

New invariant:

> The bytes a verification command sees are a function of the code snapshot id and the prepared
> environment — not of the worker's worktree.

A snapshot is not a commit: `createCodeSnapshot` records `baseline_commit` plus the working-tree
delta and untracked files, and hashes the result into `worktree_digest`
(`src/workspace/repository-context.ts`). So the export is not `git archive HEAD`; it is a
**materialize-then-verify** step:

1. Copy the snapshot's worktree (the task worktree at snapshot time) into a fresh temporary
   directory, excluding `.git` and `.delivery`. On APFS, `cp -c` (clonefile) makes this cheap for
   large trees.
2. Recompute the content manifest of the copy and compare its digest with the snapshot's
   `worktree_digest`. A mismatch is a hard error (`source_digest_mismatch`), never a fallback to
   the live worktree.
3. Run the command with `cwd` inside the copy.
4. Record `source: 'snapshot'` and `source_digest_verified: true` in evidence; `code_snapshot_id`
   stays the binding.

Long term the cleanest form is to make snapshots materializable on their own (commit the
snapshot's content to a private ref under `refs/delivery/snapshots/`, then export from that ref,
so a snapshot survives worktree recycling). P0 does not need it: verification happens while the
snapshot is current, and the digest check catches any drift.

Excluding `.git` also makes repository-internals protection structural: the copy has no hooks,
config, or objects to write — the same outcome Codex reaches with a protected-path list, by a
simpler route.

`trusted-host` gets the same treatment, which is a deliberate behavior change: the backend now
means "run on the host, weak isolation", not "run in the worker's tree". A debug escape hatch
(`source: 'worktree'`) may exist, but it is recorded in evidence and cannot satisfy a mandatory
acceptance condition.

## 7. Two-phase verification (P2)

Offline verification and dependency installation are incompatible in one phase: a fresh snapshot
has no `node_modules`, and installing them needs the network.

```yaml
verification:
  prepare:
    enabled: true
    commands: ["npm ci --prefer-offline --no-audit"]
    cache_dir: "~/.delivery-loop/env-cache"    # outside the repo
```

Semantics:

- **prepare**: network allowed, output stored at `<cache_dir>/<key>/`. It runs in a scratch
  directory populated with the snapshot's dependency manifests only (lockfiles and toolchain
  pins), so the installed tree is a function of the lockfile rather than of the worker's machine.
  Prepare output is *not* evidence, and nothing prepare produces is written back into the snapshot
  export.
- **verify**: network denied (where the backend can), `<cache_dir>/<key>` mounted or copied
  read-only, only the snapshot export and a private temp dir writable.
- Evidence records `env_digest` so an acceptance condition can require a specific environment.

This is the same two-phase shape Codex Cloud uses (setup may reach the network; the agent phase
runs offline), applied to verification instead of generation.

## 8. Failure taxonomy

The seam hands back `denialSignatures` and `runnerFailureRules`; using them replaces the current
"exit code 125/126/127 means container trouble" heuristic.

| Class | Signal | Evidence | Controller action |
| --- | --- | --- | --- |
| `runner-unavailable` | `confine` throws `SANDBOX_UNAVAILABLE`; spawn `ENOENT`/`EACCES` on `argv[0]` | `result: 'error'`, `runner_failure: true` | run `BLOCKED` + decision; never a repair task |
| `denied` | non-zero exit and stderr matches `denialSignatures` | `result: 'failed'`, `denied: true` | decision + repair task naming the blocked path; never an ordinary test failure |
| `command-failed` | exit != expected, no denial signature | `result: 'failed'` | existing repair flow |
| `timeout` | process interrupted / terminated | `result: 'error'` | existing retry + budget |
| `policy-mismatch` | requirement not satisfiable at start | no evidence | `delivery_start` rejects |

The distinction matters: a blocked write (for example, a test that wants to write into the source
tree) is an environment problem that a code patch cannot fix, while `runner-unavailable` means no
verification happened at all. Both must be visible, neither may be recorded as "tests failed".

## 9. Evidence schema additions

```ts
export interface VerificationFacts {
  backend: VerificationBackend;
  enforcement: 'full' | 'partial';
  source: 'snapshot' | 'worktree';
  source_digest_verified: boolean;
  fences: { write: string; read: string; network: string };
  env_digest?: string;
  phase: 'prepare' | 'verify';
  runner_failure: boolean;
  denied: boolean;
  denial_signatures?: string[];
}
```

Added to `EvidenceRecord` as `facts: VerificationFacts` (one field, so the shape stays easy to
extend). Existing fields are unchanged, so old run directories stay readable.

Acceptance uses these facts: a mandatory condition may declare
`min_write_fence: 'full'` / `network: 'denied'`, and `acceptance.ts` only counts evidence that
satisfies it. This is the part that prevents a future weaker backend from "passing" a run that
was supposed to be verified under a stronger one.

## 10. Integration points

| Location | Change |
| --- | --- |
| `src/domain/types.ts` | `VerificationBackend`, `BackendCapabilities`, `VerificationFacts`; extend `VerificationConfig` |
| `src/config/config.ts` | defaults; repository-level weakening guard for the new fields; requirement validation |
| `src/verification/command-runner.ts` | split into `spawnHost` / `spawnContainer` / `spawnOsSandbox`; snapshot export; classification via seam facts |
| `src/verification/snapshot-export.ts` (new) | materialize a snapshot to a temp dir; recompute the manifest and require `worktree_digest` equality |
| `src/verification/env-cache.ts` (new) | prepare phase; digest key; lookup + population |
| `src/runtime/runtime-factory.ts` | pass `sandbox` (optional) and the env cache into `CommandRunner`; keep `terminationGraceMs` |
| `src/dsh/host.ts` | read `ctx.get('sandbox')` once and pass it down; absence is a capability fact, not a crash |
| `src/controller/delivery-controller.ts` | start-time matching; failure classification; evidence facts |
| `src/controller/acceptance.ts` | fact-aware acceptance |
| `src/dsh/view-service.ts`, `client.js` | backend / enforcement / fence badges; degraded-evidence warning |
| `docs/configuration.md` | document the new fields and the matching rules |

No new runtime processes. `os-sandbox` commands are spawned by the same `runSupervisedProcess`
with the confined argv, so cancellation, timeout, and output redaction are unchanged.

## 11. Non-goals

- VM or microVM isolation (Firecracker, Apple `container`). The `container` backend already covers
  the "different world" lane through whatever runtime is installed.
- Remote execution and hosted runners.
- Full dependency hermeticity (Nix/Bazel). The env cache keyed by lockfile digest is the chosen
  middle ground.
- A read fence for `os-sandbox`. DSH's policy vocabulary is file-write only; adding read and
  network dimensions is an upstream change (see §15).
- Windows `enforcement: full` for `os-sandbox`.

## 12. Rejected alternatives

| Alternative | Why not |
| --- | --- |
| Keep `container` as the only real backend | Unusable on machines without a runtime; the project's own verification report lists real container isolation as unverified for exactly this reason |
| Make `os-sandbox` the new default immediately | Silently weakens runs that were approved under container semantics; defaults stay explicit until the requirement model is in place |
| Fall back to `trusted-host` when a sandbox is unavailable | Destroys the meaning of evidence; this is the failure mode Claude Code ships by default (`failIfUnavailable` off) and it is wrong for an acceptance system |
| Build SBPL/bwrap profiles inside the plugin | Two platforms to maintain, drifts from DSH's escalation and approval semantics, and duplicates a seam that already exists |
| Run verification in the worker | Removes the independent check that the whole loop is built on |
| Use Apple `container` as the default runtime | macOS 26 + Apple silicon only, and its CLI does not accept the `docker run` flag set the container backend emits (`--security-opt`, `--pids-limit`, `--pull=never`); would need an adapter for a young product |

## 13. Rollout

Each phase is shippable on its own.

**P0 — snapshot input (1–2 days).**
- Export + run in export for all three backends; `source` recorded.
- Acceptance criteria: a test that mutates a tracked file or test in the worktree after the
  snapshot cannot change the verdict; a post-snapshot edit of a manifest path yields
  `source_digest_mismatch` instead of a silent pass; ignored dependency trees (`node_modules`) are
  copied from the worktree and recorded as `deps_source: 'worktree'` rather than being claimed
  clean (T2 stays open until P2); existing suites stay green; `trusted-host` runs produce
  `source: snapshot`.

**P1 — `os-sandbox` + requirements (2–4 days).**
- Backend implementation, capability declaration, start-time matching, failure taxonomy.
- Acceptance criteria: on a Mac without a container runtime, a prepared run completes end to end
  with `source: snapshot`, `write: full`; a command writing outside the export yields evidence with
  `denied: true` plus a decision, and is never recorded as an ordinary test failure; a
  `network: denied` requirement rejects the run at start; `partial` enforcement cannot satisfy
  `enforcement: required`.

**P2 — prepare/verify split (2–3 days).**
- Env cache, `env_digest`, offline verify.
- Acceptance criteria: two runs with an unchanged lockfile reuse one cache entry; a changed
  lockfile produces a new key; a verify-phase command attempting a network call fails under
  `container` and is recorded as `network: open` under `os-sandbox` rather than passing silently.

## 14. Decisions (resolved)

1. **`fail_if_unavailable`, default `true`.** The name follows the seam's contract, not Claude's
   setting; a verification system must never downgrade silently. Frozen in the schema.
2. **Defaults for `requirements`:** `write_fence: required`, `read_fence: best-effort`,
   `network: any`, `reproducible_env: best-effort`, `enforcement: required`. A backend that cannot
   meet `required` is rejected at `delivery_start`.
3. **Windows threshold.** `enforcement: required` is the default, so the `partial` ACL backend is
   rejected out of the box; the prepared spec (user-approved) may opt down to `best-effort`, and
   the evidence then records `enforcement: 'partial'` with a view warning. No implicit opt-down,
   and never from a repository-level `delivery.yaml`.
4. **Prepare-phase egress.** Prepare has network access and runs inside the same write fence as
   verify (container, or `os-sandbox` writing only into the cache target). Its commands may come
   from the approved `delivery.yaml` only — never from the task graph or a worker. A per-command
   egress allowlist is deferred (§15).
5. **Backend default.** `container` remains the schema default; `os-sandbox` is opt-in. Defaults
   must not silently weaken runs that were approved under container semantics. The local
   recommendation (`os-sandbox` on macOS/Linux, `container` in CI) belongs in the quickstart, not
   in the schema default.

## 15. Deferred and upstream asks

1. **DSH sandbox policy dimensions.** `SandboxPolicy` covers file writes only. A `network: 'deny'`
   and a `filesystem.denyRead` list would let `os-sandbox` reach parity with Codex and Claude Code
   for T4/T6. On macOS both are cheap to express in SBPL (`(deny network*)`,
   `(deny file-read* (subpath ...))`); on Linux, bwrap's `--unshare-net` and Landlock's TCP rules
   cover the same ground. The missing piece is the policy field, not the platform.
2. **Per-command egress allowlist for prepare** (local proxy or a seam-level network policy).
   Deferred until §15.1 exists; full network is acceptable while prepare commands are
   configuration-owned.
3. **Snapshot materialization through `refs/delivery/snapshots/`.** Deferred from P0; the digest
   check makes it unnecessary while verification runs against a current snapshot.

## 16. Compatibility and migration

- `delivery.yaml` keeps `version: 1`; all new fields are optional and default to today's
  behavior (`backend: container`, `source: snapshot` once P0 lands).
- Existing run directories remain readable: `facts` is additive.
- The plugin gains an optional dependency on DSH's `sandbox` service. If the service is absent,
  `os-sandbox` is reported as unavailable and the run blocks with a clear decision; nothing else
  changes.
