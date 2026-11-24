# Third-party Skill licenses

This directory holds the full license texts for skill content vendored from other projects. The root [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) is the canonical summary.

| File | Content | Upstream |
| --- | --- | --- |
| `superpowers.txt` | MIT license for Skill content | [obra/superpowers](https://github.com/obra/superpowers) |
| `openspec.txt` | MIT license for Skill content | [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) |

The exact SHA-256 for every vendored `SKILL.md` and its resources is recorded in [`../skills.lock.yaml`](../skills.lock.yaml). The sync script (`npm run update:skills`) updates that lock; `npm run verify:skills` checks it.

Vendored content is copied, not linked, so the license text must stay next to it and in the published package.
