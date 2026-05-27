# Security policy

## Threat model — read this first

agent-master is a **LAN-only** homelab tool. It deliberately:

- **Binds to `0.0.0.0:7890`** so you can reach it from your phone on the same network.
- **Has no authentication.** Anyone on your LAN can call `POST /api/spawn` or read agent metadata.
- **Spawns shell processes** via AppleScript (`POST /api/spawn` → `claudepeers` in Terminal.app).
- **Reads your macOS keychain** for the Claude Code OAuth token (`security find-generic-password -s "Claude Code-credentials"`).
- **Sends the OAuth token** to `api.anthropic.com/api/oauth/usage` to fetch plan utilization.

Run it **only on trusted networks**. Do not expose port 7890 to the public internet.

## What is *not* exposed

- Your OAuth token is never written to disk or logged. It lives only in the keychain (per macOS).
- `data/registry.json` is gitignored — your local agent catalog stays local. Only `data/registry.example.json` (the demo) is committed.

## Reporting a vulnerability

If you find a security issue (e.g. a way to escape the AppleScript spawn payload, exfiltrate the keychain entry, or call the API cross-origin from a malicious page on the same LAN):

**Do not open a public issue.** Instead:

1. Email the maintainer via the address listed on the GitHub profile of [`meintechblog`](https://github.com/meintechblog), or
2. Open a [GitHub Security Advisory](https://github.com/meintechblog/agent-master/security/advisories/new) (private).

Please include:

- A clear description of the issue
- Steps to reproduce
- Affected version (commit hash or release tag)
- Your assessment of impact

I'll respond within a few days and coordinate on disclosure timing.

## Supported versions

Only the latest commit on `main` receives security fixes. There are no LTS branches.
