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
2. Adds the `claudepeers` alias to `~/.zshrc` if missing
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
│  Sidebar          │  5h-Block 23%  $4.20   Woche 57%  $42.30              │
│  ─────────        │  ▓░░░░                ▓▓▓▓░                          │
│  ● demo-hub       │  reset: Mo. 01.06. 00:00                              │
│  ● demo-domain ▶  │  in 3d 11h                                            │
│  ○ demo-bridge    ├───────────────────────────────────────────────────────│
│  ◌ demo-other     │  demo-domain-lxc          [● live] [Stop]             │
│                   │  Example domain agent…                                │
│                   │                                                       │
│                   │  Capabilities: http-api, metrics-collection           │
│                   │  Deployment:   lxc · proxmox-host · 10.0.0.50:80      │
│                   │  Endpoints:    GET http://10.0.0.50/api               │
│                   │  Depends on:   demo-hub                               │
└───────────────────┴───────────────────────────────────────────────────────┘
  ●  live in broker     ○  registered, not running     ◌  health-check down
```

- **Sidebar:** one button per agent, sorted by live-status + role (Hub/Bridge/Infra/Domain). Coloured dot = live state, health LED = HTTP-ping status.
- **Header:** Plan-% (the same data Claude Code's `/usage` slash command shows) combined with ccusage's API-equivalent cost, plus a live countdown until the 5h-block and weekly window reset.
- **Main panel:** capabilities, when-to-use, deployment, owned endpoints, MQTT topics, dependencies, secrets location, live dashboards, memory references. Spawn or Stop button depending on live state.

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
                              ├─ dismiss dev-channel dialog (Enter)
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
| `/api/status` | GET | Agents + live-status + counts |
| `/api/registry` | GET | Raw `registry.json` |
| `/api/peers` | GET | Broker peers + agent metadata merged |
| `/api/usage` | GET `?refresh=1` | ccusage active block + 7d totals (5min cache) |
| `/api/plan-usage` | GET `?refresh=1` | Claude-Code plan %-utilization (5h + 7d, 5min cache) |
| `/api/health` | GET `?refresh=1` | Parallel health-check pings (60s cache) |
| `/api/events` | GET | **SSE stream** — `status` (3s), `usage` + `plan_usage` (5min) |
| `/api/spawn` | POST `{agent:"<key>"}` | Spawn a new claudepeers tab |
| `/api/stop` | POST `{agent:"<key>"}` | SIGTERM peer + close its Terminal tab |

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
| Spawn opens a window but the dev-channel dialog stays | Foreground app changed during the 12 s wait | Re-run; check `data/spawn.log` for the captured window id |
| ccusage shows `n/a` for a while after install | `npx ccusage` first-run is downloading | Wait ~30 s, refresh |
| Stop signal sent but Terminal tab stays | Peer registered with `tty: null` (rare) | PID was signalled; close the tab manually |

More detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#failure-modes).

## Contributing

PRs welcome. Particularly: Linux support (gnome-terminal/kitty spawning), iTerm2 support, additional registry fields you'd find useful.

Style: short focused functions, no npm dependencies if avoidable, plain HTML/CSS/JS (no build step).

## License

MIT — see [LICENSE](LICENSE).
