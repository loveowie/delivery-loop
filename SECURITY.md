# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.2.x | Yes |
| < 0.2 | No |

The project is pre-1.0. Security fixes are released on the latest minor line; upgrade to the newest patch before reporting.

## Report a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:

- <https://github.com/loveowie/delivery-loop/security/advisories/new>

Include:

- the plugin version, DSH version, Node version, and OS;
- the affected surface (tool, view API, finalization, verification, state, packaging);
- a minimal reproduction or proof of concept;
- the impact you believe is possible, and any preconditions (local session, crafted repository, malicious worker, etc.);
- relevant logs with secrets, tokens, and private paths removed.

If GitHub private reporting is unavailable, contact the maintainer on GitHub ([@loveowie](https://github.com/loveowie)) and ask for a private channel. Do not include exploit details in a public message.

## What to expect

This is a small, maintainer-run project. We aim to acknowledge a report within 7 days, confirm or dispute the impact, and keep you informed until a fix ships. There is no bug bounty.

We will credit reporters in the release notes unless you ask to stay anonymous. Please give us a reasonable window to release a fix before public disclosure; we will coordinate a date with you.

## Scope

In scope:

- the Host plugin (`dist/dsh/host.js` and `src/`) and the browser half (`client.js`);
- the view API: authentication, path validation, symlink handling, file-read caps, and the settings write whitelist;
- finalization: confirmation binding, hook disabling, and refusal of unsupported modes;
- verification: container arguments, environment filtering, evidence redaction, and the fail-closed contract;
- worker launch: prompt construction, output schema validation, and task-id checks;
- state handling: atomic writes, revision checks, lock handling, and traversal;
- packaging: files shipped in the npm tarball and the DSH bundle;
- vendored skills, when the issue is in the plugin's integration rather than the upstream content.

Out of scope:

- **DSH itself** — report to the DeepSeek Harness project.
- **The host operating system or container runtime** — a container escape or kernel bug is not a Delivery Loop vulnerability.
- **A malicious repository owner** with the same local privileges as the user running DSH; the plugin is not a multi-tenant boundary.
- **`trusted-host` verification** — it is explicitly not isolation. A malicious verification command running with the user's privileges is the documented behavior of that opt-in mode.
- **A reviewer or acceptance task writing files** — the documented control is a prompt plus an independent snapshot check, not an OS sandbox. A bypass of the snapshot check *is* in scope.
- **Findings that require already having the user's DSH session, filesystem, or credentials**, unless the plugin amplifies that access beyond its documented surface.

## Security model and known boundaries

Read [Architecture: trust boundaries](docs/architecture.md#trust-boundaries) for the shipped guarantees. The most important ones:

- Verification defaults to a fail-closed container with no network, no capabilities, a read-only source mount, and a digest-pinned image that must already exist locally. It never silently falls back to host execution.
- `trusted-host` is opt-in in the approved prepared configuration and requires `allow_trusted_host: true`. It is not isolation.
- Reviewer and acceptance read-only behavior is prompt-based plus a controller snapshot check, not an OS sandbox.
- The view API is same-origin and authenticated by the DSH browser session, with a per-process token fallback. It refuses paths outside the run's repository, worktrees, and `.delivery` directory, rejects symlink escapes, and caps reads.
- The settings API accepts only the runtime budget whitelist and rejects every other configuration key.
- Finalization requires an explicit mode and `<run-id>:<mode>` confirmation, and its commits disable repository hooks, signing, and the file-system monitor.
- Workers inherit the initiating session's DSH sandbox and approval policy; the plugin does not grant them additional permissions.

If you believe a documented boundary is weaker than stated, that is a security report. Please include the exact claim and the reproduction.

## Safe harbor

We will not pursue legal action against researchers who:

- make a good-faith attempt to avoid privacy violations, data loss, and service disruption;
- test only against their own installations and repositories;
- report through the private channel and allow time for a fix;
- do not exploit a finding beyond what is needed to demonstrate it.

## Dependency and disclosure hygiene

- Runtime dependencies are limited to `proper-lockfile`, `yaml`, and `zod`.
- CI runs `npm audit --omit=dev` on every push and pull request.
- Vendored skills are hash-locked in `capabilities/skills.lock.yaml` and attributed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Release builds should be published with npm two-factor authentication; provenance is recommended when released from CI.
