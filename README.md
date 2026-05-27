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
3. Installs a macOS LaunchAgent that auto-restarts the server
4. Smoke-tests `http://localhost:7890`

Open the URL printed at the end. Done.

Uninstall:

```bash
bash ~/codex/agent-master/install.sh --uninstall
```

## What you see

- **Sidebar:** one button per agent, sorted by live-status + role (Hub/Bridge/Infra/Domain). Green dot = live, health LED = HTTP-ping status.
- **Header right:** Plan-% (the same data Claude Code's `/usage` slash command shows) combined with ccusage's API-equivalent cost.
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

A `wallbox-master` peer needs `energy-master` for a correlation:

```bash
curl -X POST http://localhost:7890/api/spawn \
  -H 'Content-Type: application/json' \
  -d '{"agent":"energy-master"}'
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
        "host": "proxmox-01 (192.168.1.2)",
        "lxc_id": 145,
        "ip": "192.168.1.50",
        "port": 80
      },
      "health_check": { "url": "http://192.168.1.50/health", "method": "GET", "expected_status": 200 }
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

## Contributing

PRs welcome. Particularly: Linux support (gnome-terminal/kitty spawning), iTerm2 support, additional registry fields you'd find useful.

Style: short focused functions, no npm dependencies if avoidable, plain HTML/CSS/JS (no build step).

## License

MIT — see [LICENSE](LICENSE).
