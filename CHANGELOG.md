# Changelog

All notable changes to **agent-master** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-27

Initial public release.

### Added

- **Webapp + HTTP-API** on `localhost:7890` (LAN-binding) with vanilla Node.js (zero npm dependencies)
- **Capability Registry** (`data/registry.json`) — per-agent metadata: role, capabilities, when-to-use, deployment (LXC/host/IP/port/plist), owned endpoints, MQTT topics, dependencies, secrets location, repo URL, health-check, memory references, live dashboards, tags
- **Tab UI** with dark theme, one tab per agent, sorted by live-status + role
- **Peer-to-peer spawn** via `POST /api/spawn` — automates the dev-channel dialog dismissal via AppleScript
- **Peer stop** via `POST /api/stop` — SIGTERM on PID + Terminal-tab close (matches tab by tty)
- **Plan-usage display** — undocumented `api.anthropic.com/api/oauth/usage` endpoint (the data behind Claude Code's `/usage` slash command), OAuth token read from macOS keychain
- **ccusage integration** — runs `npx --yes ccusage blocks --json` for API-equivalent cost (active 5h-block + 7d totals)
- **Combined view** — plan-% headline + API-$ "as if you'd paid" subtitle, details drawer aufklappbar
- **Live updates via SSE** (`/api/events`) — status (3s cadence) + usage (5min) + plan_usage (5min), pauses entirely when no clients connected
- **Visibility-aware client** — disconnects SSE when tab is hidden, reconnects on focus
- **Health-checks** — parallel HTTP-pings (60s cache, TBD-URL skipped, POST-body honored)
- **macOS LaunchAgent** for auto-restart
- **One-line installer** (`install.sh`) — idempotent, sets up directory + claudepeers alias + LaunchAgent
- Documentation: `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/REGISTRY.md`

### Known Limitations

- OAuth token refresh not yet implemented; uses the token as-is (re-login via `claude auth` if expired)
- AppleScript spawn/stop is macOS-only (no Linux/Windows equivalent yet)
- Registry pflege ist manuell — peers können Updates per send_message vorschlagen, der Hub patcht JSON

[Unreleased]: https://github.com/meintechblog/agent-master/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/meintechblog/agent-master/releases/tag/v0.1.0
