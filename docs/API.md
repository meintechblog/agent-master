# API reference

Base URL: `http://localhost:7890` (or whatever `AGENT_HUB_PORT` is set to).

All responses are JSON unless noted. No auth — LAN-only.

## `GET /api/status`

The big aggregate call. Used by the UI on first paint.

```json
{
  "agents": {
    "wallbox-master": {
      "repo": "/Users/hulki/codex/wallbox-master",
      "role": "Domain",
      "description": "openWB-Pro-Emulator…",
      "capabilities": ["twc-control", "openwb-emulation"],
      "deployment": { "type": "lxc", "host": "proxi", "ip": "192.168.3.92" },
      "key": "wallbox-master",
      "live": true,
      "peer_id": "ij9w3ene",
      "last_seen": "2026-05-27T12:42:23.571Z",
      "live_summary": "monitoring Carport-Guest tests",
      "pid": 97062,
      "tty": "ttys001"
    }
  },
  "online_count": 5,
  "total_count": 17,
  "updated_at": "2026-05-27T13:00:00.000Z"
}
```

## `GET /api/registry`

Raw `data/registry.json`. Useful for peers that want to discover capabilities of others.

## `GET /api/peers`

Live peers from the broker, joined with registry metadata.

```json
{
  "peers": [
    {
      "id": "ij9w3ene",
      "pid": 97062,
      "cwd": "/Users/hulki/codex/wallbox-master",
      "git_root": "/Users/hulki/codex/wallbox-master",
      "tty": "ttys001",
      "summary": "wallbox-master: monitoring…",
      "registered_at": "2026-05-27T12:31:08.540Z",
      "last_seen": "2026-05-27T12:42:23.571Z",
      "agent_key": "wallbox-master",
      "agent": { "role": "Domain", "...": "..." }
    }
  ],
  "online_count": 5
}
```

## `GET /api/usage` `?refresh=1`

ccusage-derived API-equivalent cost. Cached 5 min unless `refresh=1`.

```json
{
  "active_block": {
    "id": "2026-05-27T11:00:00.000Z",
    "startTime": "2026-05-27T11:00:00.000Z",
    "endTime": "2026-05-27T16:00:00.000Z",
    "costUSD": 110.0,
    "totalTokens": 155123456,
    "burnRate": {
      "costPerHour": 48.92,
      "tokensPerMinute": 1127635
    },
    "projection": {
      "remainingMinutes": 178,
      "totalCost": 241.13,
      "totalTokens": 333468099
    },
    "minutes_left": 178
  },
  "last_7d": { "cost": 4192.34, "tokens": 6320500000, "blocks": 29, "since": "2026-05-20T13:00:00Z" },
  "total_blocks": 125,
  "cached": false,
  "age_ms": 0,
  "generated_at": "2026-05-27T13:02:24.193Z"
}
```

Soft-fail: if `npx ccusage` is unreachable, returns `{ error: "..." }`.

## `GET /api/plan-usage` `?refresh=1`

Claude Code plan utilization — the data behind `/usage` in interactive sessions. Cached 5 min.

```json
{
  "five_hour":  { "utilization": 18, "resets_at": "2026-05-27T16:40:00Z" },
  "seven_day":  { "utilization": 57, "resets_at": "2026-05-31T22:00:00Z" },
  "seven_day_sonnet": { "utilization": 0, "resets_at": null },
  "seven_day_opus":   null,
  "extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null, "utilization": null, "currency": null, "disabled_reason": null },
  "subscription_type": "max",
  "rate_limit_tier": "default_claude_max_20x",
  "cached": false,
  "age_ms": 0,
  "generated_at": "2026-05-27T13:02:24Z"
}
```

### Plan-usage internals

This data does **not** come from any documented API. Here's how it works:

1. Read the OAuth token from the macOS keychain:
   ```bash
   security find-generic-password -s "Claude Code-credentials" -a "$USER" -w
   ```
   Returns a JSON blob: `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-…","refreshToken":"…","expiresAt":<ms>,"scopes":[…],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}`.

2. Call:
   ```http
   GET https://api.anthropic.com/api/oauth/usage
   Authorization: Bearer <accessToken>
   anthropic-beta: oauth-2025-04-20
   ```

The endpoint is undocumented. It exists because the Claude Code CLI calls it for its `/usage` slash command. We discovered it by `strings`-grepping the Claude Code binary at `~/.local/share/claude/versions/<ver>` and pattern-matching `/api/[a-z_/]*usage`.

**Caveat:** Anthropic may change this any time. If 401, the token expired — re-run `claude auth login` and the next request picks up the new token from keychain. Token refresh handling is not implemented.

## `GET /api/health` `?refresh=1`

Parallel HTTP-pings of each agent's `health_check.url`. 3 s timeout, 60 s cache.

```json
{
  "checks": {
    "wallbox-master":     { "status": "ok",   "http_status": 200, "expected": 200 },
    "energy-master":      { "status": "skip", "reason": "TBD" },
    "logging-master":     { "status": "ok",   "http_status": 200, "expected": 200 },
    "netzbetreiber-master": { "status": "down", "reason": "fetch failed" }
  },
  "cached": false,
  "age_ms": 0,
  "generated_at": "2026-05-27T13:02:30Z"
}
```

Status meanings:

- `ok` — HTTP status matched `expected_status`
- `warn` — got an unexpected status code
- `down` — request failed (timeout, DNS, connection refused, …)
- `skip` — no `health_check.url` or it contains `"TBD"`

## `GET /api/events`

Server-Sent Events stream. Emits three event types:

```
event: status
data: { ...same shape as /api/status... }

event: usage
data: { ...same shape as /api/usage... }

event: plan_usage
data: { ...same shape as /api/plan-usage... }
```

Cadence:
- `status` every 3 s
- `usage` and `plan_usage` every 5 min

On connect, the server immediately pushes one of each.

When no clients are connected, the schedulers no-op (the broker isn't polled, ccusage isn't spawned).

## `POST /api/spawn`

Body:

```json
{ "agent": "energy-master" }
```

Responses:

- `200` `{ ok: true, repoKey, windowId, cwd }` — spawned
- `200` `{ already_running: true, peer: { ... } }` — peer is already in the broker
- `400` `{ error: "missing_agent" | "invalid_json" }`
- `404` `{ error: "unknown_agent" }`
- `500` `{ error: "spawn_failed", reason: "..." }`

Takes ~15 s (12 s wait + dialog dismiss + broker registration).

## `POST /api/stop`

Body: same as `/api/spawn`.

Responses:

- `200` `{ ok: true, agent, signaled: true, tab_closed: true, peer_id }` — done
- `200` `{ not_running: true, agent }` — wasn't live to begin with
- `404` `{ error: "unknown_agent" }`
- `500` `{ error: "stop_failed", reason: "..." }`

Side effects:

1. `SIGTERM` is sent to the peer's PID
2. After 1.5 s, the Terminal tab matching the peer's tty is closed (with `close window` as fallback)

Both steps are best-effort and logged to `data/spawn.log`.
