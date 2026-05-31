# Registry schema

`data/registry.json` is the source of truth. The server re-reads it on every API call (no restart needed when you edit).

## Top-level

```jsonc
{
  "_meta": {
    "version": 2,
    "updated_at": "ISO-8601",
    "maintained_by": "string",
    "operator": "string (first name of the human operator — referenced in peer messages and WA replies)",
    "operator_wa": "+49… (E.164 phone, used by wa-bridge as the routing target)",
    "operator_github": "github-username",
    "hub_name": "string (name the Hub agent identifies as toward peers — e.g. 'Hulki', 'Aurora'. Distinct from the operator name.)",
    "naming_policy": "free-text reminder for peers: Hub-Agent has its own name (≠ the human's name). Helps avoid mixing them up in messages.",
    "spawn_command": "claudepeers",
    "spawn_pattern": "AppleScript … (informational)",
    "doc_ref": "path or URL",
    "schema_doc": "free-text reminder of fields"
  },
  "agents": {
    "<key>": { /* agent object */ }
  }
}
```

The `operator` / `hub_name` separation is intentional: peers should refer to the human by `operator` (e.g. "Jörg") and to the Hub agent by `hub_name` or the Hub's `display_name` (e.g. "Hulki"). Mixing them up makes peer-to-peer routing decisions ambiguous ("send this to Jörg" vs. "send this to the Hub").

`<key>` is the short slug used in URLs and the UI (e.g. `demo-domain-lxc`). Should match a directory name in `~/codex/` for the spawner to find the repo, unless `repo` is explicitly set.

## Per-agent fields

| Field | Type | Required | Used by | What |
|---|---|---|---|---|
| `repo` | string (absolute path) | yes | spawner | Where to `cd` before running `claudepeers` |
| `role` | `"Hub" \| "Bridge" \| "Domain" \| "Infra"` | yes | UI | Sidebar sort + color badge |
| `display_name` | string | optional | UI, peers | Human-friendly name the agent identifies as (e.g. `"Hulki"` for the Hub). Falls back to the registry key if absent. |
| `description` | string | yes | UI | One-liner in the main panel |
| `capabilities` | string[] | recommended | UI | Skill chips |
| `when_to_use` | string[] | recommended | UI | Bulleted list of situations |
| `deployment` | object | recommended | UI | See [deployment object](#deployment-object) |
| `owned_endpoints` | array | optional | UI, peers | What HTTP/MQTT/etc. this agent exposes |
| `mqtt_topics` | `{publishes, subscribes}` | optional | UI | Topics the agent uses |
| `depends_on` | string[] | optional | UI | Other agents / services |
| `secrets_at` | string | optional | UI | Where credentials live (path or memory-ref) |
| `repo_url` | string | optional | UI | GitHub URL |
| `health_check` | object | optional | health-checker | See [health-check object](#health-check-object) |
| `memory_refs` | string[] | optional | UI | Names of memory files for the agent |
| `live_dashboards` | string[] | optional | UI | URLs of live dashboards |
| `tags` | string[] | optional | UI, filter | Free-form tags |
| `color` | hex string | optional | UI | Accent color for chips and the title bullet |
| `alias_for` | string | optional | spawn | Mark this entry as an alias of another agent |
| `recurring_tasks` | array | optional | UI | Declared periodic triggers `[{name, schedule, note, loads_agents}]` (cron/intervals/watchers) — fleet-load transparency |
| `lifecycle_idle_exempt` | bool | optional | lifecycle watcher | Skip auto idle-shutdown (no auto-respawn). Context-recycle still applies |
| `keep_alive` | bool | optional | lifecycle watcher | Always-on: Hub auto-respawns the session if down + never idle-shuts it down (implies idle-exempt). E.g. `chat-llm-master` |

### Deployment object

Free-form key-value (the UI shows all keys it finds). Common shapes:

```jsonc
// LXC on Proxmox
{ "type": "lxc", "host": "proxmox-host (10.0.0.2)", "lxc_id": 100, "ip": "10.0.0.50", "port": 80, "service_name": "demo-domain", "install_method": "deploy/install.sh in repo" }

// macOS LaunchAgent
{ "type": "launchd-agent", "host": "Mac", "service_name": "com.example.demo-bridge", "plist": "~/Library/LaunchAgents/com.example.demo-bridge.plist" }

// Docs-only repo (no service)
{ "type": "docs-repo", "host": "Mac (local)", "manages": ["thing A", "thing B"] }

// Alias
{ "type": "alias", "for": "demo-domain-lxc" }

// External service
{ "type": "external", "host": "nas-host", "ip": "10.0.0.9", "port": 8080 }
```

Known recognized keys (the UI renders these in a fixed order): `type`, `host`, `lxc_id`, `ip`, `port`, `service_name`, `plist`, `install_method`, `service_path`, `lan_ip`, `for`, `manages`, `fallback_ip`, `alt_lxc_id`. Any other key is ignored by the UI but harmless.

### Health-check object

```jsonc
{
  "url": "http://10.0.0.50/api",
  "method": "GET",           // optional, default GET; "POST" sends "{}" body
  "expected_status": 200     // optional, default 200
}
```

Special values:

- `url: null` or missing → skipped, LED is grey
- `url` containing `"TBD"` → skipped, LED is grey
- Method `POST` → automatically sends `Content-Type: application/json` + body `{}`

### Owned-endpoints array

```jsonc
[
  { "method": "GET",  "path": "http://10.0.0.50/api", "purpose": "Domain API" },
  { "method": "MQTT", "path": "mqtt://10.0.0.200:1883", "purpose": "broker" },
  { "method": "FILE", "path": "~/code/demo-bridge/data/outbox/<uuid>.json", "purpose": "atomic write → bridge picks up message" }
]
```

`method` is free-form — `GET`/`POST`/`MQTT`/`FILE`/`TCP`/… The UI just renders it as a label.

## Example: minimum viable agent

```jsonc
"my-thing": {
  "repo": "/Users/you/code/my-thing",
  "role": "Domain",
  "description": "Does the thing.",
  "capabilities": ["thing"]
}
```

That's it. Everything else is optional progressive enhancement.

## Editing flow

1. Edit `data/registry.json` (any editor, JSON validation in your editor is recommended)
2. Reload the browser tab — the server re-reads on every API call
3. No restart needed

The file is the source of truth. There is no migration tooling because there's nothing to migrate against.

## Future direction

A self-describing flow where each peer pushes its own `capabilities` via `set_summary` JSON would let the Hub auto-merge updates. Not implemented yet. PRs welcome.
