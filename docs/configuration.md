# Configuration

Repository configuration lives in `delivery.yaml`. The merged configuration is frozen into `.delivery/runs/<run-id>/resolved-config.yaml` when a run starts. Start overrides supplied to `delivery_start` apply only to that run.

## Minimal portable configuration

```yaml
version: 1
profile: portable

spec:
  provider: native

runtime:
  max_parallel_workers: 2
  max_task_attempts: 3
  no_progress_cycles: 3
  max_duration_hours: 8
  max_total_tokens: 2000000

verification:
  execution:
    backend: container
    # Required for commands: a preloaded project image pinned by digest.
    image: "your-build-image@sha256:<64 lowercase hex digits>"
  baseline: true
  commands:
    build: ["npm run build"]
    test: ["npm test"]
    lint: ["npm run lint"]
    e2e: []

git:
  mode: prepare-only
  worktree_isolation: true
```

`runtime.daemon_mode` no longer exists: the DSH plugin always runs the controller in the Host process and workers as native subagents.

## Board settings (runtime budgets)

The Delivery board and each run's view link to a **Settings** page. It is the intended
way to change run budgets: no `delivery.yaml` edit is needed. Each budget row shows the
value that will be saved, the built-in default, the effective value and the layer it
comes from; a paused or blocked run can be raised from the same page.

- Global default: `~/.delivery-loop/settings.json` (or `$DELIVERY_LOOP_HOME/settings.json`).
- Repository: `<repo>/.delivery/settings.yaml`.

Only these runtime fields are accepted; every other key is rejected by the settings API
and must stay in `delivery.yaml`, because verification, git and review policy are part
of the approved contract:

| Field | Meaning | Default |
| --- | --- | --- |
| `max_total_tokens` | cumulative token budget per run | 2,000,000 |
| `max_duration_hours` | wall-clock budget per run | 8 |
| `max_task_attempts` | attempts per task (re-dispatch rounds) | 3 |
| `no_progress_cycles` | consecutive scheduler cycles without progress before blocking | 3 |
| `max_parallel_workers` | tasks executing at the same time | 2 |
| `default_worker_timeout_seconds` | timeout of one worker attempt | 1800 |

Precedence for a new run:

```
defaults < repository delivery.yaml < prepared delivery.yaml
         < global settings < repository settings < delivery_start.config_override
```

Values are frozen into `.delivery/runs/<run-id>/resolved-config.yaml` when the run
starts, so a panel change never alters a running run. To raise a budget for a paused
or blocked run, open that run's **Settings** panel and choose **Apply to current run**;
it resumes the run with the increased `max_total_tokens`, `max_duration_hours` or
`max_task_attempts`. Budgets can only be increased, matching `delivery_resume`.

The panel writes the same JSON/YAML a human can edit by hand. An invalid file fails the
next start with the file path and the offending field instead of being ignored quietly.

The view API exposes the same data as `GET ${apiPrefix}/settings?repo_root=<path>` and
`POST ${apiPrefix}/settings` with `{ scope, repo_root?, runtime?, reset? }`.

## Optional OpenSpec provider

```yaml
profile: openspec
spec:
  provider: openspec
  minimum_cli_version: "1.7.0"
```

Select this only when the target project uses OpenSpec and the CLI is installed. Copying the OpenSpec Skill does not install the CLI. Task execution remains in the internal DAG; this is a spec-discovery provider, not an external agent runtime.

## Project Skills

Project Skills are explicit extensions:

```yaml
capabilities:
  project_skills:
    - .delivery/skills/project-testing
```

The path must contain `SKILL.md`. The default portable profile does not require any project Skill.

## Task graph

The prepared graph must be acyclic. Each task declares:

- `status`, `priority`, `risk` and `origin`;
- `depends_on`;
- requirement and acceptance IDs;
- allowed `scope_paths`;
- `required_outputs`;
- worker role and capability profile;
- verification commands and review policy.

Dependencies unlock only after the upstream task is integrated and marked `DONE`.

A requirement must be satisfiable: either it has at least one mandatory acceptance condition, or at least one covering task declares a verification command. The graph is rejected at `delivery_start` otherwise. Completed tasks' verification commands are included in the final verification matrix and re-run at the accepted snapshot. Mandatory `artifact` acceptance is checked against the produced `delivery.patch` digest; mandatory `review` acceptance requires `review.final_review: true`.

## Git modes

- `prepare-only`: produce an integration worktree and `delivery.patch`; do not touch the main checkout or create commits.
- `commit`: create a local commit and park it on `refs/delivery/<run-id>` so it cannot be pruned with a detached worktree.
- `branch`: create a delivery branch and commit after explicit confirmation.
- `push`: push the confirmed branch after explicit confirmation.
- `merge`: reserved for a project-specific finalizer; the generic finalizer refuses this mode before writing any journal state.

No finalization action runs merely because the run reaches `COMPLETED`. `delivery_finalize` requires `confirmation` to be exactly `<run-id>:<mode>`; a bare run id is rejected. Finalization commits disable repository hooks, signing and fsmonitor so worker-delivered content is never executed on the host.

## Verification execution policy

New runs default to `verification.execution.backend: container`. Commands require an explicitly digest-pinned, locally available image; the runtime never pulls an image implicitly. The container has no network, capabilities or host home mount. A copy of source, excluding `.git` and `.delivery`, is mounted read-only at `/workspace`; temporary output belongs in `/tmp`. Toolchains and dependencies must already exist in the image. Commands that write into the source tree must be adjusted for an external output directory.

For a trusted local project, explicitly opt in to host execution in the **prepared** configuration:

```yaml
verification:
  execution:
    backend: trusted-host
```

The repository-level `delivery.yaml` cannot select `trusted-host`; doing so is rejected. The `delivery_start` call must additionally pass `allow_trusted_host: true` after the user explicitly approves host execution. Host mode filters environment variables and uses an empty temporary home; it is **not** OS isolation. Missing runtime/image causes error evidence and blocks the run; it never falls back to host execution.

`delivery_start.config_override` is limited to `runtime`, `review`, `git` and `workers`. Verification policy, capabilities, profile and spec provider must live in the prepared `delivery.yaml` so the approved document matches what runs.

## DSH bundle configuration

The bundle's loader row accepts:

```yaml
- id: delivery-loop
  name: 'dsh-delivery-loop'
  config:
    apiPrefix: /delivery-loop
    defaultRepoRoot: /optional/fallback/repository
    modelInvocableSkill: true
    systemPrompt: true
    subagentProvider: spawn
    # subagentMaxDepth: 4
```

- `apiPrefix`: absolute HTTP prefix for the view API (`runs`, `run`, `file`, `diff`, `action`). Defaults to `/delivery-loop`. The browser half uses the default path; change it only together with `client.js`.
- `defaultRepoRoot`: used by a tool call that omits `repo_root` when the session has no working directory. Normal calls use the session working directory or the run registry.
- `modelInvocableSkill`: registers `deliver-change` in the DSH skill catalog. Defaults to `true`.
- `systemPrompt`: adds a short Delivery Loop section to the system prompt. Defaults to `true`.
- `subagentProvider`: the `ctx.subagents` provider used for task workers. Defaults to `spawn`, the in-process fresh-child provider. A provider must support `outputSchema`.
- `subagentMaxDepth`: optional recursion cap passed to the provider. Omit it to leave the cap to the provider/default depth policy.

These fields configure the DSH Host plugin only; they do not change per-run `DeliveryConfig`, which still comes from `delivery.yaml` and `delivery_start.config_override`.
