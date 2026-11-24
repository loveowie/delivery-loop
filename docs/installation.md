# Installation

This guide installs Delivery Loop into DeepSeek Harness (DSH), verifies the installation, and covers upgrade and removal.

## Requirements

| Requirement | Details |
| --- | --- |
| DeepSeek Harness | 0.2.x. The plugin registers native tools, a skill, a system-prompt section, and a browser view. |
| Node.js | 24 or newer. The bundled Skill scripts and the Host build target Node 24. |
| Git | Required in every repository you deliver into. |
| Container runtime | Optional. Required only when `verification.execution.backend` is `container` (the default). |
| Disk | The npm package is small; run state, evidence logs, and worktrees live in the target repository's `.delivery/` directory and can grow with long runs. |

The plugin is not an external service. It has no daemon, no listening port of its own, and no external agent CLI.

## Install from the plugin marketplace

1. Open **Plugins → Discover** in DSH.
2. Search for **Delivery loop** (the package name is `dsh-delivery-loop`).
3. Install the bundle. Installation adds the package to the profile and selects the bundle.
4. Open **Plugins → Installed** and confirm that the **Delivery loop** bundle is enabled.
5. Look for the **Delivery loop** entry in the left sidebar.

Marketplace entries are third-party content. Check the listed version and repository before installing.

## Install from npm

Ask the agent to install and enable the bundle, or open **Plugins → Add plugin** and enter the package name:

```text
Install the dsh-delivery-loop bundle from npm and enable it.
```

The package declares `dsh.bundle.patch` (`cordis.patch.yml`), which inserts one loader row:

```yaml
- id: delivery-loop
  name: 'dsh-delivery-loop'
  config:
    apiPrefix: /delivery-loop
    modelInvocableSkill: true
    systemPrompt: true
```

The Host half is `dist/dsh/host.js`; the browser half is `client.js`.

## Install from source

```bash
git clone https://github.com/loveowie/delivery-loop.git
cd delivery-loop
npm ci
npm run build
```

`npm run build` compiles `src/` to `dist/`. Then install the directory as a local bundle:

- **Plugins → Add plugin** and select the checkout directory, or
- `plugin_manager` with `action: install_bundle` and the absolute directory path.

Local directory installation links the checkout: changes under `dist/` are visible after a restart, but the browser half (`client.js`) is a hand-maintained file that is not produced by `npm run build`.

## First-run verification

After installation:

1. **Tools.** In a new session, the agent should list ten `delivery_*` tools (`delivery_start` … `delivery_finalize`).
2. **Skill.** The `deliver-change` skill should appear in the skill catalog unless `modelInvocableSkill` is `false`.
3. **View.** The left sidebar should show **Delivery loop**; opening it should render the board without an error.
4. **View API.** The board's Settings page should load. An unauthenticated request to the view API must answer `401`; the view itself uses the DSH browser session (Desktop forwards its Host cookie), with a per-process token fallback.
5. **Demo data (optional, source checkout).** `npm run demo:view` creates a synthetic completed run in a temporary Git repository and registers it under the board. Delete the printed repository directory and its `~/.delivery-loop/runs.json` entry when finished.

If the board is empty, that is normal: no delivery has been started yet.

### If the view returns 401

The page is running a client bundle that has no valid session credential, usually after a plugin upgrade.

1. Reload the DSH page.
2. If the page still fails, restart the Desktop app so the Host reloads the plugin package.
3. Confirm the DSH Connection service is composed. Without a browser session or token injection, the plugin does not serve the view unauthenticated: requests are rejected instead.

### If a tool or the skill is missing

- Check that the bundle is enabled, not only installed.
- Check the Host log for `[delivery-loop] host plugin ready`; a failed activation reports the missing seam.
- Confirm the composition provides `ctx.tools`, `ctx.agents`, and `ctx.subagents`. The default DSH web profile does.

## Configure the target repository

Delivery Loop reads `delivery.yaml` from the repository root. A minimal portable configuration is:

```yaml
version: 1
profile: portable

runtime:
  max_parallel_workers: 2
  max_task_attempts: 3
  max_duration_hours: 8
  max_total_tokens: 2000000

verification:
  execution:
    backend: container
    image: "your-build-image@sha256:<64 lowercase hex digits>"
  commands:
    build: ["npm run build"]
    test: ["npm test"]
    lint: ["npm run lint"]

git:
  mode: prepare-only
  worktree_isolation: true
```

The repository-level file cannot enable `trusted-host` verification. That choice belongs in the approved prepared `delivery.yaml`, and `delivery_start` additionally requires `allow_trusted_host: true` after explicit user approval. See [Configuration](configuration.md).

## Upgrade

1. Finish or pause active runs. A run is owned by the Host process that started it; upgrading while a run is active is safe only if the run can be recovered afterwards.
2. Update the bundle from the marketplace, by installing the new npm version, or by pulling the source checkout and rebuilding.
3. Restart the Desktop app when the plugin package changes. A browser page only needs a reload after `client.js` changes.
4. Open the board and confirm existing runs are listed. Run state is versioned (`state_schema_version: 1`); runs stay in the target repository's `.delivery/` directory and are not migrated or deleted by an upgrade.
5. Read the [changelog](../CHANGELOG.md) for behavior changes. The plugin targets DSH 0.2.x seams, which may change between DSH releases.

## Uninstall

1. Pause or cancel active runs first. Removing the bundle while a run is executing leaves that run without a controller.
2. Remove the bundle in **Plugins → Installed** (or `plugin_manager` `remove_bundle`).
3. Restart the Desktop app.
4. Optionally delete local state:
   - per repository: `<repo>/.delivery/` (run state, evidence, worktrees, prepared specs);
   - per user: `~/.delivery-loop/` (`runs.json` index and `settings.json`).

Uninstalling the plugin does not delete Git commits, branches, or patches created by an explicitly confirmed finalization. `prepare-only` runs never touch the main checkout.

## Platform notes

- macOS is the verified local platform. CI runs unit and integration tests on Ubuntu and macOS.
- Windows is unverified. Container verification depends on a working Docker-compatible CLI; the Host uses `docker` unless `verification.execution.command` overrides it.
- Linux CI does not run a live DSH-hosted delivery; see [Testing](testing.md).
