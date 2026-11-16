Remaining P1 findings:

1. **Verification still runs repository-controlled commands through the host shell.** Environment filtering is present, but no worker sandbox is applied.  
   `src/verification/command-runner.ts:31-67`

2. **`required_outputs` is not actually validated.** The controller only checks whether any file changed; it does not verify that required code, tests, documentation, migrations, or configuration artifacts exist.  
   `src/controller/delivery-controller.ts:366-371`

3. **Final verification ignores the configured baseline verification.** It runs build/test/lint/e2e commands but never reads `verification.baseline` or executes baseline checks.  
   `src/controller/delivery-controller.ts:741-752`

4. **Cancellation can still race with reviewer execution and integration.** Reviewer workers receive no cancellation signal, and cancellation can occur after the final pre-integration check but before integration begins.  
   `src/controller/delivery-controller.ts:434-443`, `src/controller/delivery-controller.ts:495-507`

5. **Token and dynamic-depth budgets remain unenforced.** Runtime logic enforces duration and no-progress cycles, while task repair logic checks only retry count and `max_dynamic_tasks`.  
   `src/controller/delivery-controller.ts:653-674`; `src/runtime/run-manager.ts:178-200`