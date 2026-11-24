# Documentation

This directory contains the user, operator, and contributor documentation for Delivery Loop. The [README](../README.md) is the project overview; this page is the map.

## Conventions

- These documents describe version 0.2.0, the version in `package.json`. For older releases, read the matching Git tag.
- The README is maintained in English and [Simplified Chinese](../README.zh-CN.md). Detailed guides are English only; translations are welcome as pull requests.
- Documents describe the released behavior of the version in `package.json`. A proposal is marked **Proposal** and must not be read as shipped behavior.
- Internal links are relative and point at files in this repository. External links are limited to the DeepSeek Harness project, Git, npm, and standards bodies.
- Commands are written for a POSIX shell; Windows is not verified yet.

## Reading paths

**I want to install and use the plugin**

1. [Installation](installation.md)
2. [Usage](usage.md)
3. [Configuration](configuration.md)
4. [Troubleshooting](troubleshooting.md)

**I operate deliveries for a team**

1. [Operations](operations.md)
2. [Configuration](configuration.md) — budgets and verification backends
3. [Troubleshooting](troubleshooting.md)

**I want to review or contribute to the code**

1. [Architecture](architecture.md)
2. [Testing](testing.md)
3. [Contributing](../CONTRIBUTING.md)
4. [Design: verification isolation](design/verification-isolation.md) — proposal

**I maintain the release**

1. [Publishing](publishing.md)
2. [Testing](testing.md)
3. [Verification report](reports/2026-11-18-verification.md)

## Reference

| Document | Contents |
| --- | --- |
| [Installation](installation.md) | Requirements, marketplace / npm / source install, first-run checks, upgrade, uninstall |
| [Usage](usage.md) | The delivery workflow, prepared files, tool reference, budgets, finalization |
| [Configuration](configuration.md) | `delivery.yaml` reference, precedence, settings files, verification backends, Git modes, bundle configuration |
| [Architecture](architecture.md) | Components, task and run lifecycle, state model, recovery, evidence, security boundaries |
| [Operations](operations.md) | Day-to-day operation: start, observe, control, recover, retain, upgrade |
| [Troubleshooting](troubleshooting.md) | Symptom-based diagnosis and diagnostics collection |
| [Testing](testing.md) | Test layers, commands, coverage, live smoke, release gate, accepted gaps |
| [Publishing](publishing.md) | Versioning, release checklist, npm and plugin-market publication |
| [Design: verification isolation](design/verification-isolation.md) | **Proposal** for snapshot-based verification input and an OS-sandbox backend |
| [Verification report](reports/2026-11-18-verification.md) | Historical record of the 0.2.0 verification run |

## Related projects

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the host application and plugin platform.
- [Contributor Covenant](https://www.contributor-covenant.org/) — the code of conduct used by this project.
- [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/) — release conventions.
