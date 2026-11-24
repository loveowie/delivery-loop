# Verification rules

## Evidence requirements

Verification evidence must include the command, working directory, code snapshot, start and end times, exit code, and captured output paths. A result is useful only when it can be tied to those facts.

## Invalidation

Evidence is valid only for the snapshot that produced it. Integration or any later source change invalidates dependent evidence. Do not carry a passing result forward by assumption.

## Completion gate

Completion requires all of the following:

- every mandatory acceptance condition is satisfied at the accepted snapshot;
- every task is done or explicitly accepted as cancelled;
- no blocking review finding remains open.

Acceptance types:

- `command` / `test` — the controller runs the command and compares the exit code;
- `manual` — the user confirms; rejection creates an acceptance-gap repair task;
- `artifact` — checked against the produced `delivery.patch` digest;
- `review` — requires `review.final_review: true` and a passing independent review.

## What does not count

- a worker's summary, claim, or self-reported test output;
- a command run against a different snapshot;
- a passing test that the worker modified without review;
- a manual approval from an earlier snapshot;
- an artifact digest that does not match the integrated content.
