# agent-master

> Web dashboard + HTTP-API for orchestrating multiple [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) sessions across your repos. One tab per agent, spawn/stop from the browser, live status without polling, plan-usage + cost overlay.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)]()
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)]()
[![No deps](https://img.shields.io/badge/dependencies-0-green.svg)]()

## Why

If you run several Claude Code sessions in parallel — one per project repo — `claude-peers-mcp` already lets them message each other live. **agent-master** adds the discovery + control layer on top:

- **You don't remember what each agent does.** → Capability registry per agent.
- **You don't remember which agent is live.** → Live broker status in the sidebar.
- **You want to spawn another agent without typing.** → One click, dialog dismiss handled by AppleScript.
- **A running agent needs to spawn another one.** → `POST /api/spawn` — no human in the loop.
- **You want to see what each app is deployed to.** → LXC ID, host, IP, port, plist path per agent.
- **You want to see if you're about to hit your Claude plan limit.** → Plan-% headline + ccusage cost overlay.

## Quick install (macOS)

```bash
curl -sSL https://raw.githubusercontent.com/meintechblog/agent-master/main/install.sh | bash
```

The installer:

1. Clones into `~/codex/agent-master` (override with `AGENT_MASTER_DIR=…`)
2. Writes the `claudepeers` expect-wrapper to `~/.local/bin/claudepeers` (auto-dismisses the dev-channel trust prompt, no manual Enter needed)
3. Seeds `data/registry.json` from `data/registry.example.json` (edit it afterwards to register your own agents)
4. Installs a macOS LaunchAgent (`com.$USER.agent-hub`) that auto-restarts the server
5. Smoke-tests `http://localhost:7890`

Open the URL printed at the end. Done.

Update later: `git -C ~/codex/agent-master pull && launchctl kickstart -k gui/$(id -u)/com.$USER.agent-hub`.

Uninstall:

```bash
bash ~/codex/agent-master/install.sh --uninstall
```

## What you see

```
┌─ agent-master ────────────────────────────────────────────────────────────┐
│  Sidebar             │  5h-Block 23% $4.20   Woche 57% $42.30             │
│  ─────────           │  ▓░░░░               ▓▓▓▓░                        │
│  ● agent-master  HUB │  reset: 18:40                                      │
│  ● demo-domain  ▶ DOM│  in 3h 12min                                       │
│  ○ demo-bridge   BRI ├────────────────────────────────────────────────────│
│  ○ demo-external INF │  demo-domain-lxc          [● live] [Stop]          │
│                      │  Example domain agent…                             │
│                      │                                                    │
│                      │  Capabilities: http-api, metrics-collection        │
│                      │  Deployment:   lxc · proxmox-host · 10.0.0.50:80   │
│                      │  Endpoints:    GET http://10.0.0.50/api            │
│                      │  Depends on:   agent-master                        │
│                      │  Health:       ● ok (200)                          │
└──────────────────────┴────────────────────────────────────────────────────┘
  ●  live in broker        ○  not running
```

The top-right of the header has a **view toggle**: `🛰 Agenten` (the dashboard), `🧩 Skills` (skill browser with usage heatmap) and `⚙️ Settings` (data-source management).

### 🧩 Skills tab

A browser for every installed Claude Code skill — both user-installed (`~/.claude/skills/`) and plugin-shipped (`~/.claude/plugins/cache/`). On a typical Jörg setup that's 80+ skills, so it does more than just list them:

- **Stats strip** — used / brachliegend / 7d+30d invocation counts / top skill, fed live from InfluxDB.
- **Per-card usage badge** — `52× · 7d:27` style; never-used skills get a dimmed `nie`.
- **Heatmap tint** on the left border of each card, scaled to the current filter's max usage.
- **Sub-groups** — 67 `gsd-*` skills aren't shown as one flat list; they're bucketed by the official `gsd-ns-*` namespaces (Workflow / Review / Ideate / Manage / Project / Context). 13 `browse:*` skills split into Drive / Capture / Prospect / Platform.
- **Sort toggle:** `A–Z · Nutzung · Zuletzt`. The "Zuletzt" mode reveals a small activity feed above the grid showing the last 5 events (skill invocations + hub audit events, merged) — so you see what your sessions actually did in the past few minutes.
- **★ Favorites** (localStorage) — always render in a leading section.
- **Click a card** to open a modal with the full `SKILL.md` body, frontmatter meta, allowed-tools, plus a copy-`/command` button.

### ⚙️ Settings tab

- **InfluxDB sources** — list, add, edit, delete, set-default, test (probes `/health` + token + bucket). Tokens never leave the server — list responses are redacted to a `009811…db32` preview. Stored in `data/sources.json` (gitignored, chmod 600). One-time migration from a legacy `data/.influx-token` wraps the single-token setup into a default source.
- **Peer briefing** — textarea bound to `data/peer-briefing.md`. The hub automatically pushes this onboarding text to every newly-spawned `claudepeers` session (background loop polls the broker every 30 s, dedups by `peer_id` in `data/briefed-peers.json`). Save + `Alle Peers re-briefen` button if you want existing live peers to see updated content. Each briefing send emits a `briefing.sent` audit event.
- **Bisher gebriefte Peers** — list of every `peer_id` that's received a briefing, with timestamp + per-row Re-Brief button.

- **Sidebar:** one button per agent, sorted alphabetically. Coloured dot = live state in the claude-peers broker (green = registered, grey = offline). Role label on the right (Hub/Bridge/Infra/Domain).
- **Header:** Plan-% (the same data Claude Code's `/usage` slash command shows) combined with ccusage's API-equivalent cost, plus a live countdown until the 5h-block and weekly window reset.
- **Main panel:** capabilities, when-to-use, deployment, owned endpoints, MQTT topics, dependencies, secrets location, live dashboards, memory references, plus an HTTP health-check LED (separate from the broker live-state, since a service can be HTTP-reachable without a claude-peers session attached). Spawn or Stop button depending on live state.

### Refresh cadence

| What | How often | Mechanism |
|---|---|---|
| Per-agent live state (broker peers) | every **3 s** | SSE `status` event |
| Plan-% utilization + reset countdown | every **5 min** | SSE `plan_usage` event (5 min server cache) |
| ccusage cost overlay | every **5 min** | SSE `usage` event (5 min server cache) |
| Health-check LEDs (HTTP pings) | **60 s cache**, refreshed on demand | server-side, called when the UI requests `/api/health` |
| Countdown re-render | every **60 s** client tick | so "in 3h 12min" stays correct without an SSE event |

When the browser tab is hidden, the client closes the SSE connection and the server stops doing broadcast work entirely — no broker polls, no `ccusage` spawn, no keychain read. Reopening the tab reconnects automatically.

The HTTP API (`/api/status`, `/api/spawn`, `/api/stop`, …) is **always live** regardless of whether a browser is connected, since the server runs as a LaunchAgent. Other peers can `curl` it any time.

## How it works

```
Browser  ◀───── SSE ──────  agent-master server (Node, :7890)
  │                              │  ▲
  │  POST /api/spawn             │  │  claude-peers broker (:7899)
  │  POST /api/stop  ───────────►│  │  /list-peers (POST)
  │                              ▼  │
  │                         AppleScript
  │                              │
  │                              ▼
  └────────────────────────► Terminal.app
                              │
                              ├─ new tab: `cd <repo> && claudepeers`
                              │  (claudepeers is an expect-wrapper that
                              │   auto-dismisses the dev-channel prompt)
                              ├─ poll broker until peer registers (<5s typ.)
                              └─ on stop: SIGTERM PID + close tab (matched by tty)
```

- **Zero runtime dependencies.** Just `node`. Optionally `ccusage` (auto-fetched via `npx` for the cost overlay).
- **No polling from the browser.** `EventSource` + `visibilitychange`. When you switch away, the server stops doing work too.
- **No auth.** This binds to `0.0.0.0:7890` — your LAN can see it. That's deliberate (so you can hit it from your phone). Run inside a trusted network only.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/API.md`](docs/API.md) for details.

## HTTP API

| Path | Method | Use |
|---|---|---|
| `/` | GET | Web UI |
| `/api` | GET | Self-describing index — list every endpoint with purpose + body schema. Hit this from another agent to discover the surface. |
| `/api/status` | GET | Agents + live-status + counts + registry `_meta` |
| `/api/agents` | GET `?capability=X&role=Y&tag=Z&live=true` | Filtered agent list — for capability-based discovery from other peers |
| `/api/registry` | GET | Raw `registry.json` |
| `/api/peers` | GET | Broker peers + agent metadata merged |
| `/api/usage` | GET `?refresh=1` | ccusage active block + 7d totals (5min cache) |
| `/api/plan-usage` | GET `?refresh=1` | Claude-Code plan %-utilization (5h + 7d, 5min cache) |
| `/api/health` | GET `?refresh=1` | Parallel health-check pings (60s cache) |
| `/api/events` | GET | **SSE stream** — `status` (3s), `usage` + `plan_usage` (5min) |
| `/api/skills` | GET `?refresh=1` | All installed Claude Code skills (parsed from `~/.claude/skills/*/SKILL.md` + `~/.claude/plugins/cache/<mp>/<plugin>/<ver>/skills/*/SKILL.md`), grouped by cluster + sub-group. 5 min cached. |
| `/api/skills/body` | GET `?path=…` | Full `SKILL.md` body (post-frontmatter) for the detail modal. Path validated against the two trusted roots. |
| `/api/skill-usage` | GET `?trigger=1` | Background-loop status (scans transcripts every 5 min, ships `skill_invocations` to InfluxDB). |
| `/api/skill-usage/aggregated` | GET `?refresh=1` | Per-skill counts (total/7d/30d/last_used) + headline totals — feeds the Skills-tab heatmap. 60 s cached. |
| `/api/recent-activity` | GET `?limit=N` | Merged feed of last `skill_invocations` + `hub_events`, normalized `{ts, kind, label, detail}`. 30 s cached. |
| `/api/sources` | GET / POST | List configured data sources (tokens redacted) / create new source. |
| `/api/sources/:id` | PATCH / DELETE | Update / delete one source. |
| `/api/sources/:id/set-default` | POST | Promote one source to default for its type. |
| `/api/sources/:id/test` | POST | Ping the source's `/health` endpoint + verify token + bucket. |
| `/api/briefing` | GET / PUT | Get or update the auto-briefing text sent to new peers. |
| `/api/briefing/rebrief` | POST `{peer_id?\|cwd?\|all?}` | Force re-send the briefing to one peer or all currently-online peers. |
| `/api/wa-push` | GET / POST | Gateway status / push a WhatsApp message to Jörg via wa-bridge. Body: `{text, severity:info\|warn\|error\|recovered, source, dedup_key?, to_phone?}`. Dedup 10 min, rate-limit 30 / 5 min. |
| `/api/health-monitor` | GET | Health-monitor loop state + per-box current issues. |
| `/api/health-monitor/poll` | POST | Force an immediate health-monitor cycle. |
| `/api/spawn` | POST `{agent:"<key>"}` | Spawn a new claudepeers tab. Auto-clones the repo via `gh` if `repo_url` is set in the registry and the local path is missing. |
| `/api/stop` | POST `{agent:"<key>"}` | Hard-stop: SIGTERM peer + parent (expect wrapper) + close its Terminal tab |
| `/api/soft-stop` | POST `{agent:"<key>"}` | Soft-stop: channel-message the agent ("save & wrap up"), 5 min grace, then hard-stop. One `+5 min` extension available to the agent itself via `/api/soft-stop-extend`. |
| `/api/soft-stop-extend` | POST `{agent:"<key>"}` | Agent requests +5 min extension (one-shot). |
| `/api/soft-stop-cancel` | POST `{agent:"<key>"}` | Abort a pending soft-stop, agent keeps running. |

### Peer-to-peer example

A peer needs to spawn another agent (e.g. for a cross-domain correlation):

```bash
curl -X POST http://localhost:7890/api/spawn \
  -H 'Content-Type: application/json' \
  -d '{"agent":"demo-domain-lxc"}'
```

Then it can message the new peer with `mcp__claude-peers__send_message`.

## Registry

`data/registry.json` is the source of truth. See [`docs/REGISTRY.md`](docs/REGISTRY.md) for the schema. Edit and reload — the server re-reads on every API call (no restart needed).

Minimal entry:

```jsonc
{
  "agents": {
    "my-agent": {
      "repo": "/Users/you/code/my-agent",
      "role": "Domain",
      "description": "What it does in 1-2 sentences.",
      "capabilities": ["thing-a", "thing-b"],
      "when_to_use": ["When this kind of question comes up"],
      "deployment": {
        "type": "lxc",
        "host": "proxmox-host (10.0.0.2)",
        "lxc_id": 100,
        "ip": "10.0.0.50",
        "port": 80
      },
      "health_check": { "url": "http://10.0.0.50/health", "method": "GET", "expected_status": 200 }
    }
  }
}
```

## Configuration

| Env var | Default | What |
|---|---|---|
| `AGENT_HUB_PORT` | `7890` | Server port |
| `CLAUDE_PEERS_BROKER` | `http://localhost:7899` | Where the claude-peers broker is |
| `AGENT_MASTER_DIR` | `$HOME/codex/agent-master` | (installer) where to clone |
| `AGENT_MASTER_REPO` | upstream | (installer) git remote |

## Plan-usage data source

The plan-% display comes from the **undocumented** `https://api.anthropic.com/api/oauth/usage` endpoint — the same call Claude Code makes when you type `/usage` in an interactive session. The OAuth token is read from the macOS keychain (`Claude Code-credentials` service, account = `$USER`). No token is stored by agent-master itself.

If you're on Linux or your Claude Code installation uses a different credential store, the `/api/plan-usage` endpoint will fail gracefully and the UI shows ccusage-only.

See [`docs/API.md`](docs/API.md#plan-usage-internals) for details.

## Cross-repo observability (InfluxDB)

The hub ships three measurement families to whichever InfluxDB source you've set as default in `data/sources.json`:

| Measurement | Tags | Field | Written by |
|---|---|---|---|
| `skill_invocations` | `skill, project, session, branch` | `count=1i` | Background scanner that walks `~/.claude/projects/**/*.jsonl` every 5 min and ships every `Skill` tool_use event. Idempotent — timestamps are the original event time, re-running collapses by `(timestamp, tags)`. |
| `hub_events` | `kind, target, actor, severity?` | `count=1i, msg="…"` | Audit trail for every hub action: source CRUD, briefing sends, spawn/stop success/fail, soft-stop, WA-push outcomes (`wa.push.sent / suppressed / rate_limited`), health alerts. |
| `service_health` + `service_health_issues` | `agent, box, host, plugin, kind, reason, severity` | `ok_count, issue_count, worst_severity, severity_level` | Health-monitor loop polling per-box `/api/health/digest` endpoints declared in `registry.json:health_monitor`. Writes one summary point per box per tick + one event point per issue. |

The Skills-tab heatmap and Activity-Feed read straight from these — no separate Grafana setup needed for the headline numbers. Build a dashboard with the same data if you want time-series graphs.

### Auto-briefing for new peers

Whenever a previously-unseen `peer_id` appears in the claude-peers broker, the hub sends it a one-time onboarding message containing operator identity, key conventions, pointers to global `CLAUDE.md` + memory, and the "WA-pushes are opt-in" rule. Content lives in `data/peer-briefing.md` (editable from the Settings tab). State persists in `data/briefed-peers.json` so a server restart doesn't re-spam everyone.

### Central WA-push gateway

`POST /api/wa-push` is the one place WhatsApp messages to the operator are sent from. Other repos (health-monitor alerts, build/deploy failures, etc.) call this instead of writing wa-bridge outbox files themselves. Dedup (10 min per `dedup_key`), rate-limit (30 per 5 min global), severity-rendering (`ℹ️ / ⚠️ / 🚨 / ✅` + `\n— <source>` footer), and audit logging all happen in one place.

**WA-pushes are opt-in, not default.** The hub never automatically pushes "something changed" notifications. Sources have to be explicitly enabled per-target (e.g. `health_monitor.boxes[].wa_alerts: true`) — unsolicited information on Jörg's phone is the worst kind of noise.

## Manual install (without the script)

```bash
git clone https://github.com/meintechblog/agent-master.git ~/codex/agent-master
cd ~/codex/agent-master
node server.mjs
# open http://localhost:7890
```

LaunchAgent is optional — it's nice for auto-restart but not required.

## Limitations

- **macOS only.** Spawn/stop rely on AppleScript driving Terminal.app. A `tmux`/`iTerm` variant would be welcome PRs.
- **No OAuth token refresh.** If your Claude Code token expires (~weeks), re-run `claude auth login` and the next API call picks up the new token from keychain.
- **`registry.json` is hand-curated.** Future versions may auto-discover from peer `set_summary` payloads.
- **No auth.** This is deliberate (so your phone on the same LAN can reach it). Do not expose port 7890 to the public internet — see [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `spawn_failed repo dir missing` | Agent's `repo` path in `registry.json` doesn't exist on disk | Either clone the agent's repo there, or update the `repo` field in `data/registry.json` |
| Plan-usage shows `n/a` | OAuth token expired or keychain locked | `claude auth login`, then refresh the page |
| Spawn returns `registered: false` | claudepeers didn't finish booting / broker didn't see it within 20 s | Check `data/spawn.log` for the window id, look at that Terminal tab to see what claude printed |
| `claudepeers: command not found` after install | `~/.local/bin` not on PATH yet in the existing shell | Open a new terminal tab, or `source ~/.zshrc` |
| ccusage shows `n/a` for a while after install | `npx ccusage` first-run is downloading | Wait ~30 s, refresh |
| Stop signal sent but Terminal tab stays | Peer registered with `tty: null` (rare) | PID was signalled; close the tab manually |

More detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#failure-modes).

## Contributing

PRs welcome. Particularly: Linux support (gnome-terminal/kitty spawning), iTerm2 support, additional registry fields you'd find useful.

Style: short focused functions, no npm dependencies if avoidable, plain HTML/CSS/JS (no build step).

## License

MIT — see [LICENSE](LICENSE).
