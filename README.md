# Delivery Loop

Delivery Loop is a resumable end-to-end software delivery orchestrator. It turns an approved specification into a persistent task DAG, runs isolated workers, verifies their changes, converts test and review failures into new tasks, and continues until acceptance passes or a human decision is required.

It is a **native DeepSeek Harness bundle**: native `delivery_*` tools, a registered `deliver-change` skill, an HTTP view API, a Web GUI delivery view, and DSH subagent workers. The original Codex/MCP form remains in the repository as a legacy compatibility surface; it is not required by the DSH path.

The engine, scheduler, task state machine, worktrees, evidence ledger, and acceptance controller are shared by both forms.

## The DSH delivery view

The DSH bundle adds a view mode over the durable run state:

- a **Delivery Loop strip** under the session composer shows the live run, progress, and pending-decision count; click it to open the full view;
- the full view has **Overview / Tasks / Decisions / Files / Artifacts / Events** tabs:
  - progress, status, token usage, current tasks and the specification excerpt;
  - the task graph with attempts, risk, origin, dependencies, scope, failure context and changed files;
  - a chronological **decision timeline**: dispatch, worker results, verification, review findings, integration, acceptance, retries, budget blocks and every human answer;
  - changed-file preview and diff, with worktree/repository switching;
  - run artifacts (`spec.md`, `task-graph.json`, `reports/final.md`, `completion.json`, `delivery.patch`, evidence logs, worker diagnostics);
  - the raw event stream.
- **Settings → 交付循环 / Delivery loop** lists every registered run across repositories.

The view is read-only except for pause, resume, cancel, export report, and answering pending human decisions. Run data stays in the target repository's `.delivery/` directory; the cross-run index stays in `~/.delivery-loop/runs.json`.

The view API is same-origin and guarded by a per-process token injected into the DSH page. It reads only the run's repository, its worktrees, and `.delivery` artifacts, refuses paths outside those roots (including symlink escapes), and never creates a `.delivery` directory just to list runs.

## Install the DSH bundle

Requirements: DeepSeek Harness 0.2.x, Node.js 24+, and Git. DSH workers are native `ctx.subagents` children; the DSH bundle does not require the Codex CLI.

```bash
npm install
npm run build
```

In DSH, install this directory as a local bundle:

- **Plugins → Add plugin** and choose this directory, or
- ask the agent to run `plugin_manager` with `action: install_bundle` and the absolute directory.

The bundle inserts the `delivery-loop` row from `cordis.patch.yml`. Its Host half is `dist/dsh/host.js`; its browser half is `client.js`.

Bundle configuration (in the loader row config):

```yaml
- id: delivery-loop
  name: 'delivery-loop'
  config:
    apiPrefix: /delivery-loop     # HTTP prefix for the view API
    modelInvocableSkill: true     # register deliver-change in the skill catalog
    systemPrompt: true            # add the short Delivery Loop prompt section
    subagentProvider: spawn       # ctx.subagents provider used for workers
    # subagentMaxDepth: 4         # optional recursion cap for worker subagents
    # defaultRepoRoot: /path/to/repo
```

After installing or changing `client.js`, refresh the DSH page. The page loads the client bundle at boot; a running `pnpm run dev:web` watcher is only needed for automatic client reloads during development. The Host injects a per-process view token into the page and the browser half sends it with every view request; a view that shows `401` is running old page code, so refresh it.

To preview the view without starting a real delivery, run:

```bash
npm run demo:view
```

It creates a synthetic run in its own temporary Git repository, records a task graph, decisions, a pending acceptance, changed files and artifacts, and registers it under **Settings → 交付循环 / Delivery loop**. Delete the printed repository directory and its `~/.delivery-loop/runs.json` entry when done.

## Use the DSH plugin

Call the skill explicitly:

```text
使用 deliver-change 完成以下需求，并持续实现、修复、评审和验收：

<需求>
```

The skill prepares:

```text
.delivery/prepared/<draft-id>/
├── spec.md
├── task-graph.json
└── delivery.yaml (optional; repository root configuration is preferred)
```

After you approve the scope and acceptance summary, ask the agent to call `delivery_start`. Native tools:

| Tool | Purpose |
| --- | --- |
| `delivery_start` | Start an approved prepared run |
| `delivery_status` | Bounded progress, tasks, pending decisions, recent decisions |
| `delivery_inspect` | Full view payload: graph, requirements, decisions, files, artifacts |
| `delivery_watch` | Wait for progress or a terminal state |
| `delivery_respond` | Answer a pending human decision |
| `delivery_pause` / `delivery_resume` / `delivery_cancel` | Lifecycle control |
| `delivery_export_report` | Write `reports/final.md` |
| `delivery_finalize` | Explicitly confirmed post-completion Git action |

## What it provides

- `deliver-change` Skill for intake, one-time approval and status reporting.
- Native `delivery_*` tools, the view API, and the Web delivery view.
- Deterministic scheduler, task state machine, retry limits and failure fingerprints.
- Fresh-context **DSH subagent workers** for implementation, debugging, review and acceptance.
- Vendored and hash-locked generic Skills; no OpenSpec or domain Skill is required by default.
- Evidence persisted per code snapshot, with invalidation after integration changes.
- Isolated Git worktrees, Patch-based integration and `prepare-only` delivery by default.
- A durable decision journal and changed-file records for the DSH view.

## How workers run

Each task is executed by a fresh DSH child Agent started through `ctx.subagents.startActivation`:

- the child runs with the task worktree as `cwd` and its own session, tools, and abort signal;
- `outputSchema` is the engine's `AgentResult` schema, so the child must call DSH's `structured_output` tool and the controller receives a validated object;
- `delivery: 'caller'` captures the result in the controller instead of injecting a settlement message into the initiating conversation;
- the controller runs in the DSH Host process, so the installed plugin owns the loop; the run's initiating Agent is remembered for its worker tree, with a coordinator fallback after a Host restart;
- reviewer and acceptance workers are told to stay read-only, and the controller independently rejects a review that changes the candidate snapshot.

Token usage is summed from the child session's `assistant/message` usage events; a run reports `usage_incomplete: true` only when no usage event was observed.

## Install the Codex plugin form

Requirements:

- Node.js 24+
- Codex CLI authenticated on the same machine
- Git for the target repository

```bash
npm install
npm run generate:schemas
npm run build
npm run verify:skills
npm test
```

The Codex plugin root is this directory. It contains `.codex-plugin/plugin.json`, `.mcp.json`, the discoverable `skills/` directory and the compiled MCP server in `dist/`.

## Use the Codex form

Call the Skill explicitly:

```text
使用 $deliver-change 完成以下需求，并持续实现、修复、评审和验收：

<需求>
```

The Skill prepares:

```text
.delivery/prepared/<draft-id>/
├── spec.md
├── task-graph.json
└── delivery.yaml (optional; repository root configuration is preferred)
```

After you approve the scope and acceptance summary, the MCP workflow starts with `delivery_start`. Progress is available through `delivery_status` and `delivery_watch`.

## Defaults

- `portable` profile with native specifications.
- Maximum two parallel workers.
- One active write run per repository.
- Isolated detached worktrees per task.
- `prepare-only` Git mode: no commit, push, merge or deployment.
- Human confirmation required for `delivery_finalize` actions.

## Documentation

- [Configuration](docs/configuration.md)
- [Operations](docs/operations.md)
- [Evaluation](docs/evaluation.md)
- [Design](docs/design/codex-end-to-end-delivery-plugin-design.md)
- [Original implementation plan](docs/superpowers/plans/2026-10-28-delivery-loop-plugin.md)
- [Global reliability plan](docs/superpowers/plans/2026-10-28-global-reliability-plan.md)
- [Current implementation assessment](docs/reviews/2026-11-03-global-implementation.md)
- [Verification report](docs/verification-report.md)
- [Review report](docs/review-report.md)

The existing `release/delivery-loop-0.1.0.tgz` predates both the November 3 reliability fixes and this 0.2.0 DSH bundle; it has not been rebuilt or released. See [implementation status](docs/implementation/2026-11-03-progress.md).

## Runtime mode

In the DSH form, the Host plugin registers the tools and view API and runs the controller loop in the Harness process; workers are DSH subagents. In the Codex form, the MCP gateway starts a detached controller process that invokes `codex exec`. Both forms hold a run-level worker lock, persist all state under the target repository's `.delivery/`, and stop when the run reaches a terminal, paused, blocked or waiting-human state. A restarted Host or MCP gateway can resolve the repository from `~/.delivery-loop/runs.json` and resume execution. Tests may inject an in-process controller to keep feedback deterministic.

## Current reliability limits

- Local verification was performed on macOS. A macOS/Linux CI workflow is provided but has not been run remotely in this implementation session; Windows remains unverified.
- DSH workers are fresh subagents, not Codex processes. Token usage is summed from their session's assistant-message usage and is reported as incomplete only when no usage event arrives. Reviewer/acceptance read-only enforcement is prompt-based plus an independent snapshot check, not an OS sandbox.
- The DSH view and native worker path were verified through live tool calls, a completed DSH-subagent delivery run with measured token usage, live client slot registrations, HTTP API checks, and unit/integration tests. The view's rendered layout, light/dark appearance, focus behavior, and narrow-width layout were not verified in a browser in this environment; refresh the page after install or upgrade.
- Verification defaults to a fail-closed container backend requiring a preloaded digest-pinned image. This host has no container runtime; actual isolation validation remains pending. Explicit trusted-host mode is available for trusted projects.
- Artifact acceptance requires typed `artifact-check` evidence from a project provider.
- The `merge` finalization mode requires a project-specific finalizer.
- Real Git tests use scripted workers. Temporary production installation and stdio MCP startup are verified. Paid Codex protocol smoke (Codex form), container boundaries, multiprocess crash/fencing and installed-package delivery/recovery remain pending.

The November 3 changes repair content snapshots, failure-context recovery, candidate publication, read-only review, final check planning, process termination and FIFO admission. Repository lease epochs, a fully atomic run/evidence/usage journal, cross-worktree repository identity and exhaustive crash recovery remain unfinished. Passing unit/integration tests does not certify a production reliability release.
