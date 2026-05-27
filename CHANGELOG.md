# Changelog

All notable changes to **agent-master** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Identity fields in the registry.** The `_meta` block now supports `operator` (human name), `operator_wa` (WhatsApp E.164), `operator_github`, `hub_name` (what the Hub agent calls itself toward peers), and `naming_policy` (free-text reminder for peers). Per-agent `display_name` lets any agent identify itself with a friendly name (e.g. the Hub registers as `"agent-master"` but calls itself `"Hulki"`). Documented in `docs/REGISTRY.md`.
- **UI surfaces identity.** Header shows `🛰 agent-master (hub: Hulki · operator: Jörg)` when those fields are set in the registry. Detail panel renders `<key> · <display_name>` when the names differ. Falls back gracefully if absent.
- **Verbose stop-pipeline logging** in `data/spawn.log` — per-step (`begin`, `find result`, `sigterm sent`, `close result`, `done`) so failed `/api/stop` attempts can be diagnosed without instrumentation. The HTTP response also now includes a `debug` object with the same raw values (visible in browser DevTools Network tab).
- **`claudepeers` is now an expect-based wrapper** installed at `~/.local/bin/claudepeers` (replaces the previous alias in `~/.zshrc`). It auto-dismisses the `--dangerously-load-development-channels` trust prompt — confirmation cycle takes <500 ms and is invisible. Forwards extra CLI args (e.g. `claudepeers --resume`). The installer (`install.sh`) deploys the wrapper and removes any legacy alias it finds in `~/.zshrc`.
- **Broker-polling in the spawn pipeline.** `/api/spawn` now polls `POST /list-peers` every 500 ms until the freshly-spawned peer appears with matching `cwd` (20 s deadline). The response includes `registered: true|false` and `peer_id`, so callers can tell whether the spawn actually succeeded.
- **Live countdown to plan-window reset** in the header (`in 3h 12min`) under the reset timestamp, plus an `· in Xd Yh` suffix in the side panel. Ticks every 60 s client-side.
- **Alias-aware liveness:** if an agent's `deployment.type === "alias"` (or it has `alias_for`), it inherits the live state of its target. Example: an alias entry for an agent that is actually run under a different key now shows up as live when the target is live.
- **Favicon** (`public/favicon.svg`) — a dark hub-network icon matching the app's dark theme and purple accent.

### Fixed

- **`/api/stop` now actually closes the Terminal tab.** Root cause: the expect-wrapper spawns claude in a child PTY, so the broker's `peer.tty` (claude's PTY) is different from the Terminal tab's `tty` (the parent shell where expect runs). The old tty-based AppleScript lookup never matched, no tab got closed. Fix: the server now keeps an in-memory `Map<repoKey, windowId>` populated at spawn time from the AppleScript window-id return value. `/api/stop` trusts that mapping first; tty-matching remains as a fallback for manually-started sessions where claude is the only PTY in the tab.
- **`claudepeers` wrapper now actually dismisses the prompt.** First version anchored on the string `Enter to confirm`, which doesn't match because Claude's TUI fragments that phrase across the byte stream with ANSI cursor-positioning escapes (`Enter[9Gto[12Gconfirm`). Switched the anchor to `cancel` (a contiguous 6-byte token from "Esc to cancel" at the end of the prompt) plus a 5 s timeout fallback that sends Enter anyway. Result: dismissal works reliably.

### Changed

- **Spawn pipeline overhauled (end-to-end fix for the "12 s dialog wait" problem).** The old approach was: launch claude, sleep 12 s, then send `key code 36` via osascript to the captured window-id to dismiss the dev-channel prompt. That was slow (12 s overhead per spawn), brittle (a foreground-app change could send the Enter to the wrong window — the bug behind "spawn just hangs sometimes"), and visually noisy. The expect-wrapper now handles dismissal inside the spawned process itself; the server just polls for broker registration. Net: spawns return in 3–6 s typical instead of 12 s+.
- **Sidebar sort is now strictly alphabetical** (was: live-first, then by role, then by name). Less visual jitter when peers come and go.
- **Sidebar removed the health-check LED.** The HTTP-ping status was visually competing with the live-dot and creating confusion ("is the agent running?" vs. "is the service HTTP-reachable?"). Health LED now lives only in the main detail panel, with explanatory text next to it.
- **Reset timestamp no longer prepends `(Xh Ymin)`** when same-day — that info is already shown by the new live countdown directly below.

## [0.1.0] — 2026-05-27

Initial public release.

### Added

- **Webapp + HTTP-API** on `localhost:7890` (LAN-binding) with vanilla Node.js (zero npm dependencies)
- **Capability Registry** (`data/registry.example.json`, seeded to `data/registry.json` on first install) — per-agent metadata: role, capabilities, when-to-use, deployment (LXC/host/IP/port/plist), owned endpoints, MQTT topics, dependencies, secrets location, repo URL, health-check, memory references, live dashboards, tags
- **Tab UI** with dark theme, one tab per agent, sorted by live-status + role
- **Peer-to-peer spawn** via `POST /api/spawn` — automates the dev-channel dialog dismissal via AppleScript
- **Peer stop** via `POST /api/stop` — SIGTERM on PID + Terminal-tab close (matches tab by tty)
- **Plan-usage display** — undocumented `api.anthropic.com/api/oauth/usage` endpoint (the data behind Claude Code's `/usage` slash command), OAuth token read from macOS keychain
- **ccusage integration** — runs `npx --yes ccusage blocks --json` for API-equivalent cost (active 5h-block + 7d totals)
- **Combined view** — plan-% headline + API-$ "as if you'd paid" subtitle, expandable details drawer with live countdown to plan-window reset
- **Live updates via SSE** (`/api/events`) — status (3s cadence) + usage (5min) + plan_usage (5min), pauses entirely when no clients connected
- **Visibility-aware client** — disconnects SSE when tab is hidden, reconnects on focus
- **Health-checks** — parallel HTTP-pings (60s cache, TBD-URL skipped, POST-body honored)
- **macOS LaunchAgent** for auto-restart
- **One-line installer** (`install.sh`) — idempotent, sets up directory + claudepeers alias + LaunchAgent
- Documentation: `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/REGISTRY.md`

### Known Limitations

- OAuth token refresh not yet implemented; uses the token as-is (re-login via `claude auth` if expired)
- AppleScript spawn/stop is macOS-only (no Linux/Windows equivalent yet)
- Registry maintenance is manual — peers can suggest updates via `send_message`, the Hub patches the JSON

[Unreleased]: https://github.com/meintechblog/agent-master/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/meintechblog/agent-master/releases/tag/v0.1.0
