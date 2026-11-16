# Evaluation

The automated suite currently covers:

- configuration layering and provider validation;
- task graph cycles and unknown dependencies;
- state transitions and ready-task scheduling;
- scope conflict avoidance;
- Skill hash verification and role-specific OpenSpec overlays;
- worker command safety and structured results;
- command evidence, nonzero exits and secret redaction;
- bugfix and review-fix task creation;
- manual acceptance and recorded human approval;
- Patch export/application and integration snapshots;
- state, evidence and report persistence;
- MCP tool contracts and stdio server initialization;
- scripted-worker runs against real Git through repair, review, combined final acceptance and patch application.

Fresh local results are recorded in [the verification report](verification-report.md). The release verifier includes root-level tests, temporary production dependency installation and stdio MCP startup.

Before release:

```bash
npm test
npm run typecheck
npm run build
npm run verify:skills
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run verify:release
```

A real Codex worker smoke test requires an authorized model budget. Real container boundaries, multiprocess crash/fencing and installed-package delivery/recovery also remain release gates. Temporary local Git tests are part of the normal suite.
