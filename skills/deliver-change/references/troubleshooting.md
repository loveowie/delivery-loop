# Troubleshooting

- If a required Skill hash fails, stop and report the mismatch.
- If a provider CLI is unavailable, switch the configuration explicitly or remain blocked.
- If a Worker stalls, terminate its process group and recover through `INTERRUPTED` handling.
- If tests fail repeatedly with the same fingerprint, replan instead of retrying unchanged.
- If a background daemon cannot survive, use `foreground` mode and resume the persisted run.
