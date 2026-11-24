# Third-party notices

Delivery Loop itself is licensed under the [MIT License](LICENSE). This file records the third-party material redistributed in this repository and the package.

## Vendored skills

The following skill content is included under `capabilities/vendors/`. It is copied, not linked, so it is redistributed with this project. Each vendored `SKILL.md` and resource is hash-locked in `capabilities/skills.lock.yaml`.

| Upstream | Skills | License | Full text |
| --- | --- | --- | --- |
| [obra/superpowers](https://github.com/obra/superpowers) | `brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `executing-plans` | MIT © 2025 Jesse Vincent | [`capabilities/THIRD_PARTY_LICENSES/superpowers.txt`](capabilities/THIRD_PARTY_LICENSES/superpowers.txt) |
| [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) | `explore`, `propose`, `apply-change`, `archive-change` | MIT © 2024 OpenSpec Contributors | [`capabilities/THIRD_PARTY_LICENSES/openspec.txt`](capabilities/THIRD_PARTY_LICENSES/openspec.txt) |

The portable profile does not require OpenSpec. The `openspec` profile additionally requires the OpenSpec CLI, which is not bundled.

## Runtime dependencies

These packages are installed with the plugin at runtime; they are not modified.

| Package | Version | License | Copyright |
| --- | --- | --- | --- |
| [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile) | 4.1.2 | MIT | André Cruz |
| [`yaml`](https://github.com/eemeli/yaml) | 2.9.1 | ISC | Eemeli Aro |
| [`zod`](https://github.com/colinhacks/zod) | 4.6.7 | MIT | Colin McDonnell |

Exact versions are pinned in `package-lock.json`.

## Development dependencies

Development and build dependencies are not redistributed in the published package. They include TypeScript (Apache-2.0), `tsx` (MIT), and the `@types/*` packages (MIT).

## DeepSeek Harness

Delivery Loop is a plugin for DeepSeek Harness. DSH is a separate work with its own license and is not bundled here. The plugin uses DSH's published extension surfaces at runtime.

## Artwork

`icon.svg`, `assets/icon-*.png`, and `assets/screenshots/*.png` are original artwork for this project and are licensed under the project's MIT license. They contain only example data.

## Keeping this file current

When adding a dependency or vendoring skill content:

1. confirm the license permits redistribution;
2. record the upstream project, version, license, and copyright holder here;
3. keep the full license text under `capabilities/THIRD_PARTY_LICENSES/` (for bundled content);
4. update `capabilities/skills.lock.yaml` with `npm run update:skills` for vendored skills;
5. update `package.json` and `package-lock.json` for a new dependency.
