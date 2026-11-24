# Configuration

Delivery Loop configuration is split between the approved delivery contract and day-to-day runtime budgets.

- **Approved contract** — `delivery.yaml` (repository or prepared), the task graph, and verification policy. It is frozen into the run and cannot change mid-run.
- **Runtime budgets** — token, duration, attempt, progress, parallelism, and timeout limits. They can be changed from the Delivery view's Settings page without editing YAML.

## Precedence

For a new run, values are merged in this order (later wins):

```text
built-in defaults
  < repository delivery.yaml
  < prepared delivery.yaml
  < global settings (~/.delivery-loop/settings.json)
  < repository settings (<repo>/.delivery/settings.yaml)
  < delivery_start.config_override
```

The merged result is validated and frozen into `.delivery/runs/<run-id>/resolved-config.yaml`. Editing any source after start does not change a running run.

`delivery_start.config_override` is limited to `runtime`, `review`, `git`, and `workers`. Verification policy, capabilities, profile, and the spec provider must be in the approved `delivery.yaml` so the document you approved is what runs.

## Complete example

```yaml
version: 1
profile: portable

spec:
  provider: native

capabilities:
  profiles_file: capabilities/profiles.yaml
  role_skills_file: capabilities/role-skills.yaml
  fail_on_missing_required: true
  project_skills:
    - .delivery/skills/project-testing

runtime:
  max_parallel_workers: 2
  default_worker_timeout_seconds: 1800
  worker_termination_grace_seconds: 30
  max_task_attempts: 3
  no_progress_cycles: 3
  max_dynamic_tasks: 100
  max_dynamic_depth: 3
  max_duration_hours: 8
  max_total_tokens: 2000000
  repository:
    max_active_write_runs: 1

workers:
  default_profile: delivery-default
  planner_profile: delivery-planner
  implementer_profile: delivery-implementer
  debugger_profile: delivery-debugger
  reviewer_profile: delivery-reviewer
  acceptance_profile: delivery-acceptance

verification:
  execution:
    backend: container
    image: "your-build-image@sha256:<64 lowercase hex digits>"
  baseline: true
  commands:
    build: ["npm run build"]
    test: ["npm test"]
    lint: ["npm run lint"]
    e2e: []

review:
  blocking_severities: [P0, P1, P2]
  task_review_policy: risk-based
  final_review: true

git:
  mode: prepare-only
  worktree_isolation: true
  delete_worktree_on_success: false
  final_artifact: delivery.patch

notifications:
  mode: status-only
```

## Reference

### Top level

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `version` | integer > 0 | `1` | Schema version |
| `profile` | `portable`, `openspec` | `portable` | `openspec` requires `spec.provider: openspec` |

### `spec`

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `provider` | `native`, `openspec` | `native` | `custom` is rejected in 0.2.0 |
| `minimum_cli_version` | version string | none | Checked by the OpenSpec preflight |
| `directory` | path | none | Reserved; not used in 0.2.0 |

The OpenSpec provider only discovers a specification and checks the CLI version. Task execution still runs in the internal task graph; it is not an external agent runtime.

### `capabilities`

| Field | Default | Notes |
| --- | --- | --- |
| `profiles_file` | `capabilities/profiles.yaml` | Capability profiles relative to the plugin root |
| `role_skills_file` | `capabilities/role-skills.yaml` | Role-to-skill mapping |
| `fail_on_missing_required` | `true` | Must stay `true`; a missing required skill fails preflight |
| `project_skills` | `[]` | Repository-relative directories containing `SKILL.md` |

Project skills are resolved and hash-checked before a worker starts. The portable profile requires no project skill.

### `runtime`

| Field | Default | Notes |
| --- | --- | --- |
| `max_parallel_workers` | `2` | Tasks executing at the same time |
| `default_worker_timeout_seconds` | `1800` | Timeout of one worker attempt |
| `worker_termination_grace_seconds` | `30` | Grace period of a command or worker termination |
| `max_task_attempts` | `3` | Dispatch attempts per task |
| `no_progress_cycles` | `3` | Consecutive cycles without progress before blocking |
| `max_dynamic_tasks` | `100` | Repair and follow-up tasks a run may create |
| `max_dynamic_depth` | `3` | Depth of dynamically created tasks |
| `max_duration_hours` | `8` | Wall-clock budget |
| `max_total_tokens` | `2000000` | Cumulative token budget |
| `repository.max_active_write_runs` | `1` | Concurrent write runs per repository |

Budgets are enforced by the controller. A run that exhausts one enters `BLOCKED`; use `delivery_resume` with a larger value or start a new run.

### `workers`

| Field | Default | Notes |
| --- | --- | --- |
| `default_profile` | `delivery-default` | Fallback profile name |
| `planner_profile` | `delivery-planner` | Planner workers |
| `implementer_profile` | `delivery-implementer` | Implementation and test workers |
| `debugger_profile` | `delivery-debugger` | Debugger workers |
| `reviewer_profile` | `delivery-reviewer` | Review workers |
| `acceptance_profile` | `delivery-acceptance` | Acceptance workers |

The bundled DSH worker adapter accepts these names but does not change the agent preset in 0.2.0; the field is reserved for adapters that map worker profiles to models or presets.

### `verification`

```yaml
verification:
  execution:
    backend: container | trusted-host
    image: "name@sha256:<64 hex digits>"
    command: docker
  baseline: true
  commands:
    build: []
    test: []
    lint: []
    e2e: []
```

| Field | Default | Notes |
| --- | --- | --- |
| `execution.backend` | `container` | `trusted-host` is opt-in and rejected in a repository-level file |
| `execution.image` | none | Required for `container`; must be digest-pinned and locally available |
| `execution.command` | `docker` | Container CLI used by the container backend |
| `baseline` | `true` | Run configured commands before work and record pre-existing failures |
| `commands.*` | `[]` | Default commands by category; tasks can declare their own |

`container` mounts a copy of the source read-only at `/workspace`, with no network, no capabilities, a read-only root, a tmpfs `/tmp`, and a non-root user. It never pulls an image implicitly. Toolchains and dependencies must already be in the image, and commands that write into the source tree must be adjusted for an external output directory.

`trusted-host` runs `/bin/sh -c` (or `cmd.exe` on Windows) in the task worktree with a filtered environment and a temporary home. It is **not** OS isolation. It must be selected in the prepared `delivery.yaml`, and `delivery_start` must pass `allow_trusted_host: true` after the user explicitly approves host execution.

### `review`

| Field | Default | Notes |
| --- | --- | --- |
| `blocking_severities` | `[P0, P1, P2]` | Findings at these severities block integration |
| `task_review_policy` | `risk-based` | `batch` is rejected in 0.2.0 |
| `final_review` | `true` | Required for a mandatory `review` acceptance condition |

### `git`

| Field | Default | Notes |
| --- | --- | --- |
| `mode` | `prepare-only` | Default finalization mode; `delivery_finalize` still requires explicit confirmation |
| `worktree_isolation` | `true` | Must be `true` |
| `delete_worktree_on_success` | `false` | Keep worktrees for inspection by default |
| `final_artifact` | `delivery.patch` | Name of the integration artifact |

Git modes:

- `prepare-only` — integration worktree and `delivery.patch`; the main checkout is untouched.
- `commit` — local commit parked on `refs/delivery/<run-id>`.
- `branch` — delivery branch plus commit.
- `push` — push the confirmed branch.
- `merge` — requires a project-specific finalizer; the generic finalizer refuses it before writing state.

Finalization commits disable repository hooks, signing, and the file-system monitor. No Git action happens merely because a run reaches `COMPLETED`.

### `notifications`

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `mode` | `status-only` | `status-only` | Accepted for forward compatibility; no external notification is sent in 0.2.0 |

## Runtime settings

The Settings page on the board or a run view edits only these fields:

| Field | Default |
| --- | --- |
| `max_total_tokens` | 2,000,000 |
| `max_duration_hours` | 8 |
| `max_task_attempts` | 3 |
| `no_progress_cycles` | 3 |
| `max_parallel_workers` | 2 |
| `default_worker_timeout_seconds` | 1800 |

Settings live in two files:

- global: `~/.delivery-loop/settings.json` (or `$DELIVERY_LOOP_HOME/settings.json`);
- repository: `<repo>/.delivery/settings.yaml`.

They apply to runs started afterwards. A paused or blocked run can be raised from the run's Settings page with **Apply to current run**; the panel resumes the run with a larger token, duration, or attempt budget. Budgets can only be increased, matching `delivery_resume`. The panel writes the same JSON/YAML a human can edit; an invalid file fails the next start with the file path and offending field instead of being ignored.

The view API exposes the same data as `GET ${apiPrefix}/settings?repo_root=<path>` and `POST ${apiPrefix}/settings` with `{ scope, repo_root?, runtime?, reset? }`. Only the budget whitelist is accepted; every other key is rejected.

## Bundle configuration

The loader row accepts:

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

| Field | Default | Notes |
| --- | --- | --- |
| `apiPrefix` | `/delivery-loop` | Absolute HTTP prefix for the view API. The browser half uses the default path; change it only together with `client.js` |
| `defaultRepoRoot` | none | Fallback repository when a tool call omits `repo_root` and the session has no working directory |
| `modelInvocableSkill` | `true` | Register the `deliver-change` skill |
| `systemPrompt` | `true` | Add the short Delivery Loop prompt section |
| `subagentProvider` | `spawn` | `ctx.subagents` provider for workers; must support `outputSchema` |
| `subagentMaxDepth` | none | Optional recursion cap passed to the provider |

These fields configure the DSH Host plugin only. Per-run `DeliveryConfig` still comes from `delivery.yaml`, settings files, and `delivery_start.config_override`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `DELIVERY_LOOP_HOME` | Relocates the per-user directory that holds `runs.json` and `settings.json` (default `~/.delivery-loop`) |

## Validation

Configuration is validated with a strict schema. Unknown keys and invalid values fail the start with a message naming the path. Additional invariants:

- `git.worktree_isolation` must be `true`;
- `review.task_review_policy: batch` is rejected;
- `spec.provider: custom` is rejected;
- `capabilities.fail_on_missing_required` must be `true`;
- the `openspec` profile requires `spec.provider: openspec`;
- a repository-level file cannot select `trusted-host`.

The task graph has its own contract: it must be acyclic, ids must resolve, every task's `capability_profile` must match the run profile, and every requirement must be covered by a mandatory acceptance condition or a task with a verification command. See [Usage](usage.md) for the graph format.
