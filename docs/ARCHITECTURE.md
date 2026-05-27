# Architecture

agent-master is intentionally tiny: one Node script, one HTML file, one JSON registry. No build step, no dependencies, no database.

## Components

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         Browser (any modern browser)                       │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ public/index.html                                                  │  │
│  │  - Vanilla JS, no framework                                        │  │
│  │  - EventSource → /api/events                                       │  │
│  │  - visibilitychange listener (pauses SSE when tab hidden)          │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │ HTTP + SSE
┌─────────────────────────────────────▼─────────────────────────────────────┐
│                       agent-master server (server.mjs)                    │
│                                                                            │
│   Endpoints:                  Caches:                Schedulers:           │
│   /api/status          ──┐    healthCache (60s)      broadcastStatus (3s)  │
│   /api/registry          │    usageCache (5min)      broadcastUsage (5min) │
│   /api/peers             ├──► planUsageCache (5min)  → both no-op when     │
│   /api/usage             │                              sseClients is empty│
│   /api/plan-usage        │                                                 │
│   /api/health            │    Spawn/Stop pipeline:                         │
│   /api/events  (SSE)     │      1. Patch ~/.claude.json trust flag         │
│   /api/spawn  (POST)     │      2. AppleScript Cmd+T + `claudepeers`       │
│   /api/stop   (POST)   ──┘      3. Poll broker until peer registers       │
│                                  4. (stop) SIGTERM PID + close tab by tty  │
└────┬─────────────────────────────┬────────────────────────────────────────┘
     │                             │
     │ POST /list-peers            │ child_process spawn:
     ▼                             │   - osascript (Terminal control)
┌──────────────────────┐           │   - security (keychain read)
│ claude-peers broker  │           │   - npx ccusage blocks --json
│ localhost:7899       │           ▼
└──────────────────────┘    ┌──────────────────────────────────────────┐
                            │ macOS keychain                            │
                            │  service = "Claude Code-credentials"     │
                            │  account = $USER                          │
                            │  payload = {claudeAiOauth: {...}}         │
                            └──────────────────────────────────────────┘
                                            │
                                            ▼
                            ┌──────────────────────────────────────────┐
                            │ api.anthropic.com/api/oauth/usage         │
                            │ (Bearer + anthropic-beta: oauth-2025…)    │
                            └──────────────────────────────────────────┘
```

## Design decisions

### Zero dependencies

The only non-trivial subprocess is `npx --yes ccusage` for the cost overlay, and that's lazy + cached + soft-failing. The server itself uses only Node 18+ built-ins: `node:http`, `node:fs/promises`, `node:child_process`, global `fetch`, `URL`, `EventSource`-compatible SSE on the response side.

Why: this is a personal-infra tool. Dependency churn for a 500-line script is overkill, and `npm install` shouldn't be a precondition for a homelab dashboard.

### SSE that pauses

Two things converge:

1. **Server short-circuits when `sseClients.size === 0`.** `broadcastStatus` and `broadcastUsage` return immediately if nobody is listening — no broker call, no `npx ccusage` spawn, no keychain read.
2. **Client closes EventSource on `visibilitychange` → hidden.** When the tab is in the background, the connection is dropped, which the server sees as `req.on("close")` and removes the client.

Net effect: when you're not looking, the only cost is the running process. When you are looking, broker is polled every 3s (cheap, local Bun) and `ccusage` / `oauth/usage` every 5 min (capped).

### Spawn pipeline via AppleScript + expect-wrapper

There's no programmatic "open a Terminal tab and run X" API on macOS, so we drive Terminal.app via osascript. Two non-obvious wrinkles:

1. **`do script "…"` without `in`** opens a new window. We want a new tab → first send Cmd+T via System Events, then `do script "…" in selected tab of front window`.
2. **The dev-channel dialog.** `--dangerously-load-development-channels server:claude-peers` triggers a blocking "I am using this for local development" prompt. `--channels` skips the prompt but doesn't support `server:` entries — fails silently at runtime.

   **Solution:** the `claudepeers` command itself is an `expect(1)` wrapper at `~/.local/bin/claudepeers` (installed by `install.sh`). It `spawn`s claude, `expect`s the "Enter to confirm" string and sends `\r`, then `interact` hands the full TTY back to the user. The whole confirmation cycle takes <500 ms and is invisible to whoever launched it.

   Previously this was handled by `setTimeout(12000)` + `osascript "key code 36"` from the server, which was slow (12 s overhead per spawn), brittle (foreground app changes could send the Enter to the wrong window), and noisy (you saw the dialog flash on screen). Both problems are gone with the wrapper.

3. **Peer registration polling.** After the AppleScript spawn returns, the server polls `POST /list-peers` against the broker every 500 ms (with a 20 s deadline) until the new peer with matching `cwd` appears. Then `/api/spawn` returns `{ ok: true, registered: true, peer_id: ... }`. If the deadline hits, returns `{ registered: false }` — the spawn might have failed inside claude. Check `data/spawn.log`.

### Stop pipeline via tty matching

A peer registers in the broker with `tty` like `ttys001`. AppleScript Terminal tabs expose a `tty` property as `/dev/ttys001`. We:

1. Scan all windows × tabs, match by tty
2. `SIGTERM` the peer's PID (Claude exits cleanly, deregisters from broker)
3. Wait 1.5 s, then `close tab N of window W` (with `close window W` as fallback)

This is more graceful than `kill -9`: Claude gets to deregister, and you don't end up with a stale Terminal tab.

### Plan-usage source

See [API.md#plan-usage-internals](API.md#plan-usage-internals) for the full reverse-engineering trail. Short version:

- `claude -p "/usage"` doesn't work (slash commands aren't evaluated in print mode)
- Found `/api/oauth/usage` by `strings`-grepping the Claude Code binary
- Bearer token lives in macOS keychain under `Claude Code-credentials` (a `genp` entry, account = `$USER`, accessible via `security find-generic-password -w`)
- `anthropic-beta: oauth-2025-04-20` header required
- Response is the exact data Claude Code's `/usage` slash command renders

### Registry: hand-curated JSON

`data/registry.json` is one file you edit. Each API request re-reads it (it's tiny), so no restart needed. There's no schema validation library — adding fields gracefully degrades because the UI uses `?.` everywhere.

Future direction: each peer could push a `set_summary` payload with structured `capabilities` and the Hub would merge into the registry. Not done yet.

## Failure modes

| Symptom | Likely cause | Recovery |
|---|---|---|
| Plan-usage shows error | OAuth token expired or keychain locked | `claude auth login` |
| Spawn opens window but no dialog dismiss | Foreground app changed; the script targets a wrong window | Re-run; or check `data/spawn.log` for the captured window id |
| Stop doesn't close tab | Peer registered with `tty: null` (rare) | Tab stays; PID is signalled; close tab manually |
| ccusage shows `n/a` | `npx` couldn't reach the registry (offline) or first invocation hasn't downloaded yet | Wait + retry; runs in background |
| Health-check says `warn 404` | The agent's `health_check.url` doesn't match a real endpoint | Fix the registry entry |

## File layout

```
agent-master/
├── server.mjs                  # The whole backend
├── public/
│   ├── index.html              # The whole frontend
│   └── favicon.svg
├── data/
│   ├── registry.example.json   # Tracked — demo catalog with example agents
│   ├── registry.json           # gitignored — your local agent catalog (seeded from example on install)
│   ├── spawn.log               # gitignored — append-only audit
│   ├── server.stdout.log       # gitignored — LaunchAgent stdout
│   └── server.stderr.log       # gitignored — LaunchAgent stderr
├── docs/
│   ├── ARCHITECTURE.md         # This file
│   ├── API.md                  # Endpoint details
│   └── REGISTRY.md             # Schema for registry.json
├── install.sh                  # Idempotent macOS installer (generates the LaunchAgent plist inline)
├── package.json                # Version + scripts (no dependencies)
├── LICENSE
├── CHANGELOG.md
└── README.md
```
