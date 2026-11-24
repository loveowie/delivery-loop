# Worker contracts

## Inputs

Workers receive a bounded objective, requirement and acceptance IDs, allowed paths, context files, verification commands, a timeout, resolved skill paths, frozen decisions, and baseline failures.

## Outputs

Workers return a structured `AgentResult`:

- status: `completed`, `blocked`, or `failed`;
- a summary;
- files changed;
- commands run, with exit codes;
- review findings with severity and evidence;
- remaining risks;
- suggested tasks;
- blockers for the controller to turn into human decisions.

## Prohibited

Workers must not:

- ask the user directly;
- create nested delivery runs;
- commit or push;
- edit outside the task scope;
- claim verification they did not run.

Any human decision must be returned as a blocker so the controller can enter `WAITING_HUMAN`.

## Controller checks

A task is not accepted merely because a worker says it is done. The controller re-runs task and acceptance checks at the final integrated snapshot, checks scope and required outputs, and independently rejects a review that changed the candidate snapshot. A worker that returns `blocked` without blockers still produces an answerable human decision. A worker that cannot prove its work with a command must be covered by a mandatory acceptance condition instead.
