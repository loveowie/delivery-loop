# Examples

## Portable delivery

`portable/` is a complete prepared run for the default `portable` profile:

```text
portable/
├── delivery.yaml      # run configuration
├── spec.md            # goal, scope, acceptance, non-goals
└── task-graph.json    # requirements, acceptance, one implementation task
```

To try it against a small repository:

1. Copy the directory into the target repository:

   ```bash
   mkdir -p .delivery/prepared/greeting
   cp -R examples/portable/. .delivery/prepared/greeting/
   ```

2. Adjust `delivery.yaml` for the repository: verification commands, image, and Git policy. The example has no container image, so either add one or set `verification.execution.backend: trusted-host` in this **prepared** file and approve host execution at start.

3. Review `spec.md` and `task-graph.json`. The example assumes `src/greeting.ts` and `tests/greeting.test.ts` exist or can be created, and that `npm test` is the verification command.

4. Approve the scope with the user, then start the run:

   ```text
   delivery_start(prepared_directory: ".delivery/prepared/greeting", allow_trusted_host: true)
   ```

   `allow_trusted_host` is required only for `trusted-host` verification.

5. Follow it with `delivery_watch`, or open the Delivery loop board.

The example's `run_id` is `draft`; `delivery_start` replaces it with the actual run id.

## Adapting the example

- Keep one requirement per outcome, and give each a mandatory acceptance condition or a covering task with a verification command.
- Start with one implementation task. Split by scope and dependency only when the work genuinely allows parallel or ordered execution.
- Put commands that prove the change in `verification_commands`; the controller re-runs them independently.
- Use `review_policy: required` for user-visible or risky changes; `risk-based` lets the configured risk decide.

See [Usage](../docs/usage.md) for the full prepared-file reference.
