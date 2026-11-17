# Configuration

Repository configuration lives in `delivery.yaml`. CLI or MCP start options override it for one run. The merged configuration is frozen into `.delivery/runs/<run-id>/resolved-config.yaml`.

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

## Optional OpenSpec provider

```yaml
profile: openspec
spec:
  provider: openspec
  minimum_cli_version: "1.7.0"
```

Select this only when the target project uses OpenSpec and the CLI is installed. Copying the OpenSpec Skill does not install the CLI. The current implementation checks CLI availability and overlays OpenSpec Skills; task execution remains in the internal DAG. It does not implement a separate OpenSpec lifecycle adapter.

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

## Git modes

- `prepare-only`: produce an integration worktree and `delivery.patch`; do not touch the main checkout or create commits.
- `commit`: allow an explicit post-completion local commit.
- `branch`: create a delivery branch and commit after explicit confirmation.
- `push`: push the confirmed branch after explicit confirmation.
- `merge`: reserved for a project-specific finalizer; the generic finalizer refuses this mode.

No finalization action runs merely because the run reaches `COMPLETED`.

## Verification execution policy

New runs default to `verification.execution.backend: container`. Commands require an explicitly digest-pinned, locally available image; the runtime never pulls an image implicitly. The container has no network, capabilities or host home mount. A copy of source, excluding `.git` and `.delivery`, is mounted read-only at `/workspace`; temporary output belongs in `/tmp`. Toolchains and dependencies must already exist in the image. Commands that write into the source tree must be adjusted for an external output directory.

For a trusted local project, explicitly opt in to host execution:

```yaml
verification:
  execution:
    backend: trusted-host
```

Host mode filters environment variables and uses an empty temporary home; it is **not** OS isolation. Container execution has not been validated on this development host because a container runtime is unavailable. Missing runtime/image causes error evidence and blocks the run; it never falls back to host execution.

Initial plans may contain only PENDING/READY tasks with attempt 0 and PENDING requirements. Runtime status, completion claims, worktree paths and failure metadata belong to the controller. `worktree_isolation: false`, `task_review_policy: batch`, `spec.provider: custom`, and ignoring missing required Skills are rejected until implemented.

Worker role profiles and termination grace are now passed to the executor. Run Skill assignments and full content tree hashes are frozen; an old bundle without role assignments requires explicit migration. Final verification includes every mandatory command/test acceptance check and honors its expected exit code. Artifact acceptance without a provider blocks with a missing-evidence diagnostic.

## DSH bundle configuration

The DSH bundle's loader row accepts these fields:

```yaml
- id: delivery-loop
  name: 'delivery-loop'
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

Task workers are DSH child Agents started with `delivery: 'caller'`, the task worktree as `cwd`, and the engine's `AgentResult` schema as `outputSchema`. The controller runs in the Host process; it remembers the initiating Agent for the run, and uses a coordinator fallback if that Agent is gone after a Host restart. Reviewer and acceptance workers are instructed to stay read-only and are also checked against the candidate snapshot.

These fields configure the DSH Host plugin only; they do not change per-run `DeliveryConfig`, which still comes from `delivery.yaml` and `delivery_start.config_override`.
