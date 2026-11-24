# Publishing

This guide is for maintainers cutting a Delivery Loop release and publishing it to npm and the DSH plugin market.

## Versioning

Delivery Loop follows [Semantic Versioning](https://semver.org/):

- **MAJOR** — a change that breaks run-state compatibility, configuration, the prepared graph format, or a documented tool contract;
- **MINOR** — a backward-compatible capability;
- **PATCH** — a backward-compatible fix.

While the project is 0.x, minor releases may still change behavior; the [changelog](../CHANGELOG.md) calls out anything that affects existing runs or configuration. Tags use `v<version>` (for example `v0.2.0`).

## Release checklist

### Before the release

- [ ] The working tree is clean and the branch you release is the one CI verified.
- [ ] `CHANGELOG.md` has an entry for the version, with the date and user-visible changes.
- [ ] `package.json` has the new `version`, the correct `repository`, `homepage`, `bugs`, `license`, and `files`.
- [ ] User-facing docs match the release: README, installation, usage, configuration, architecture, testing, troubleshooting.
- [ ] `locale/en.json` and `locale/zh.json` describe the released capability, how to open it, and its limitations.
- [ ] `icon.svg`, `assets/icon-*.png`, and the four market screenshots are current, contain no real data, and are redistributable.
- [ ] `THIRD_PARTY_NOTICES.md` and `capabilities/THIRD_PARTY_LICENSES/` cover every vendored skill.
- [ ] No secrets, local paths, `.DS_Store`, `.idea/`, or generated run data are tracked.

### Verify

```bash
npm ci
npm run verify:release
npm pack --dry-run
```

`verify:release` is the gate: schema freshness, typecheck, build, skill hashes, tests, and the packed-package layout. Inspect the `npm pack --dry-run` file list yourself; the whitelist in `package.json` is the final say on what ships.

### Publish to npm

```bash
npm publish --access public
```

`prepack` runs `npm run build`, so `dist/` is fresh in the tarball even though it is not committed. The package is unscoped (`dsh-delivery-loop`) and public.

If the release is built in a trusted CI environment with a public repository, consider `npm publish --access public --provenance` so consumers can verify the build's origin. Publishing requires npm two-factor authentication; never commit a token.

After publishing:

```bash
npm view dsh-delivery-loop@<version> version
```

### Tag and release

```bash
git tag -a v<version> -m "v<version>"
git push origin v<version>
```

Create a GitHub release from the tag with notes taken from the changelog. Do not attach build artifacts that duplicate the npm tarball.

## Publishing to the plugin market

DSH plugin markets read a JSON index of installable bundles. The market reads package metadata and display resources from the package source, so the npm release must be complete before the index entry is useful.

### What the index entry needs

- **Package identity** — name `dsh-delivery-loop` and an exact version.
- **Source** — the npm registry entry, or a commit-pinned Git source. Pin the version; never point an index at a floating branch.
- **Compatibility** — the DSH version range the release supports (`engines.dsh`; the package declares `>=0.2.0 <0.3.0`). Verify the range against the market's compatibility check rather than assuming it.
- **Display metadata** — localized title and description. Prefer the package's `locale/en.json` and `locale/zh.json` values so the index and the installed plugin agree.
- **Icon** — an absolute URL or inline `data:` image. The package's own icon is `icon.svg`.
- **Repository and homepage** — links back to this repository.

The index format and its validation are owned by DSH. Validate the entry with the market's index tooling before submitting it, and keep the index version equal to the published package version.

A minimal format-1 entry looks like this. Replace the timestamp with the real publish time (Unix seconds), use the actual icon URL for the tag, and verify the range against the DSH release you support.

```json
{
  "format": 1,
  "title": { "en": "Delivery Loop", "zh": "交付循环" },
  "metadata": {
    "categories": { "delivery": { "title": { "en": "Delivery", "zh": "交付" } } },
    "labels": {},
    "sortKeys": {}
  },
  "plugins": [
    {
      "name": "dsh-delivery-loop",
      "title": { "en": "Delivery loop", "zh": "交付循环" },
      "description": {
        "en": "Resumable end-to-end delivery for DeepSeek Harness.",
        "zh": "DeepSeek Harness 的可恢复端到端交付。"
      },
      "icon": "https://raw.githubusercontent.com/loveowie/delivery-loop/v0.2.0/icon.svg",
      "author": "loveowie",
      "homepage": "https://github.com/loveowie/delivery-loop",
      "repository": { "url": "https://github.com/loveowie/delivery-loop" },
      "metadata": {
        "category": "delivery",
        "keywords": ["dsh", "dsh-plugin", "deepseek-harness", "delivery", "orchestration"],
        "labels": [],
        "sortKeys": {}
      },
      "versions": [
        {
          "version": "0.2.0",
          "publishTimestamp": 1795478400,
          "source": { "type": "npm" },
          "engines": { "dsh": ">=0.2.0 <0.3.0" }
        }
      ]
    }
  ]
}
```

The market reads the long description from the locale `meta.detail` document, then the package README, then the repository README. Delivery Loop intentionally does not declare `meta.detail`, so the package README is the detail page. Keep the README useful as a standalone page: the first screen explains the capability, and the page includes the install path, the two approval gates, and the known limitations. Keep `meta.description` self-contained as well, because the listing truncates it and does not render the README in search results.

### Market screenshots

`screenshots.json` lists the storefront images:

```json
[
  "assets/screenshots/board-light.png",
  "assets/screenshots/settings-light.png",
  "assets/screenshots/board-dark.png",
  "assets/screenshots/settings-dark.png"
]
```

All four are 1440 px wide and show the board and settings in light and dark themes. When updating them:

- use example data only — no customer names, tokens, private paths, or real run ids;
- keep light and dark variants consistent;
- capture the feature that the release adds;
- keep the files in `assets/screenshots/` and update `screenshots.json` if a name changes.

### Install verification

After the market lists the version, verify in a clean DSH profile:

1. install from the market entry;
2. confirm the localized title, description, icon, and detail page;
3. confirm all ten `delivery_*` tools and the `deliver-change` skill;
4. open the board and the Settings page;
5. start a trivial run against a temporary repository, or use `npm run demo:view` for view-only verification;
6. uninstall and confirm the plugin is gone and the profile is usable.

Record any unverified surface (for example rendered detail-page layout without browser control) in the release notes instead of claiming success.

## Rollback

- Prefer a new patch release over mutating a published version. npm permits unpublishing only for a short window and under policy restrictions.
- Deprecate a broken version with `npm deprecate dsh-delivery-loop@<version> "<reason>"` and publish a fix.
- For the market, update the index entry to the fixed version; a Git-pinned entry must pin the new commit.
- If a run-state incompatibility is found, document the affected versions and the recovery step in the changelog. Do not migrate a user's run data silently.

## Post-release

- Confirm the npm `latest` tag points at the new version.
- Confirm the market listing shows the same version and metadata.
- Confirm CI on the release commit is green.
- Announce only the verified behavior; link the changelog and the known limitations.
- Open a follow-up issue for every "not verified" item in the release notes.

## Related documents

- [Testing](testing.md) — the release gate and its gaps
- [Contributing](../CONTRIBUTING.md) — development setup and review expectations
- [Security](../SECURITY.md) — vulnerability handling
