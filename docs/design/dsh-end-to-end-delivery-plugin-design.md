# Native DSH end-to-end delivery plugin design

## Goal

Turn an approved specification into a resumable delivery DAG that runs entirely inside DeepSeek Harness: fresh DSH subagent workers, independent verification, review findings converted into repair tasks, and acceptance that only completes on current evidence.

## Non-goals

- wrapping an external agent CLI;
- an external gateway or detached controller process;
- bypassing DSH sandbox, approval, or permission policy;
- OS-level isolation for reviewers (the engine checks content instead).

## Composition

```text
DSH Web page
  ├─ composer strip / full delivery overlay / Settings page   (client.js)
  └─ delivery_* tools + view API + skill + prompt section     (Host plugin)
        │
        ├─ DeliveryService         start/status/respond/control/finalize
        ├─ DeliveryViewService     run list, detail, files, diff, token
        ├─ DeliveryRunManager      queue, in-process controller loop
        └─ DeliveryController      tick, task lifecycle, evidence, acceptance
              │
              ├─ DshSubagentWorkerAdapter  ctx.subagents.startActivation
              ├─ WorktreeManager           isolated Git worktrees
              ├─ CommandRunner             container or trusted-host checks
              └─ PatchIntegrator           patch-based integration
```

## Host plugin

`src/dsh/host.ts` registers:

- 10 native tools: `delivery_start`, `delivery_status`, `delivery_inspect`, `delivery_watch`, `delivery_respond`, `delivery_pause`, `delivery_resume`, `delivery_cancel`, `delivery_export_report`, `delivery_finalize`;
- the `deliver-change` runtime skill;
- a short system-prompt section;
- a token-guarded HTTP view API at `apiPrefix`.

The plugin hard-depends on `tools`, `agents`, and `subagents`. It fails activation if the native worker composition is unavailable.

## Worker lifecycle

For each task:

1. the controller prepares a worktree and an `AgentRequest`;
2. `DshSubagentWorkerAdapter` chooses the run's parent Agent (initiating Agent, live fallback, or coordinator);
3. it starts a caller-delivered child with `cwd`, the task prompt, and the `AgentResult` output schema;
4. the child uses DSH tools in the worktree and must call `structured_output`;
5. the adapter validates the structured value with Zod, checks `task_id`, and returns `AgentResult` with measured token usage;
6. the controller verifies content, optionally reviews it, integrates the patch, and continues.

Timeout and cancellation abort the child signal. The child's result is captured by the controller and never delivered as a parent settlement message.

## State and recovery

`run.json` is the authoritative state; `events.jsonl` carries lifecycle and decision events. `~/.delivery-loop/runs.json` maps runs to repositories. The controller loop runs in the Host, so a run resumes after a Host restart from durable state. Worker sessions are disposable; their results are already committed to run state.

## Decisions

Every meaningful transition appends a `decision` event: baseline, dispatch, worker result, scope/output violation, verification, review, integration, acceptance, retry/budget, and human answer. The view renders this as a chronological timeline and puts pending decisions first.

## View

- `conversation.composer.dock`: live strip with status, progress and pending count.
- `shell.overlay`: full modal with Overview, Tasks, Decisions, Files, Artifacts and Events.
- `settings.section`: cross-repository run list.
- `tool.call.toolview` for `delivery_*`: compact run cards.

The client uses only DSH theme tokens and locale dictionaries. It fetches the view API with a per-process token and never reads files outside the run's repository, worktrees, or `.delivery` directory.

## Security boundaries

- Workers inherit the initiating session's sandbox and approval policy.
- Reviewer and acceptance workers are instructed to stay read-only; the controller rejects a changed candidate snapshot.
- The view API validates relative paths, rejects symlink escapes, caps file/response sizes, and is token-gated.
- Finalization is explicit and defaults to `prepare-only`.

## Known extensions

- a read-only agent preset for reviewers/acceptance;
- per-worker token budget enforcement from live usage;
- a warm coordinator Agent for restarts;
- a right-sidebar tab instead of the modal.
