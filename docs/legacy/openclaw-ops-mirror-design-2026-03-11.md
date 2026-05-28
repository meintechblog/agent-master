# OpenClaw Ops Mirror Design

**Date:** 2026-03-11

## Goal

Create a local operations workspace in `/Users/hulki/codex/openclaw` that lets us start debugging a broken OpenClaw instance immediately, without having to rediscover paths, commands, logs, or first-response steps.

## Confirmed Runtime Facts

- Active OpenClaw workspace root: `/Users/hulki/.openclaw/workspace`
- OpenClaw config: `/Users/hulki/.openclaw/openclaw.json`
- Gateway start command: `openclaw gateway start`
- Gateway status command: `openclaw gateway status`
- Live logs command: `openclaw logs --follow`
- Current runtime log: `/tmp/openclaw/openclaw-2026-03-11.log`
- LaunchAgent plist: `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
- Bind address: `127.0.0.1`
- Gateway port: `18789`
- RPC/WebSocket endpoint: `ws://127.0.0.1:18789`
- Dashboard URL: `http://127.0.0.1:18789/`

## Problem

The project directory is empty. When the local OpenClaw instance fails, we currently have the facts needed to debug it, but they are not captured in a durable, task-oriented workspace. That means every outage would start with re-discovery instead of diagnosis.

## Options Considered

### 1. Pointer Repo

Store only a minimal README with paths and manual commands.

Pros:
- Lowest maintenance burden
- Fastest to create

Cons:
- Too little structure under pressure
- No repeatable diagnostics collection
- Easy to drift into tribal knowledge again

### 2. Ops Mirror

Create a lean operations repo with runbooks, known-good runtime facts, and shell scripts for health checks and diagnostics collection.

Pros:
- Fast incident response
- Low drift risk because it points to live paths instead of copying the real installation
- Easy to extend when future failures reveal gaps

Cons:
- Needs a small amount of maintenance when runtime facts change

### 3. Snapshot Mirror

Maintain docs and scripts plus regular snapshots of config and health state.

Pros:
- Better comparison during incidents
- Faster change detection

Cons:
- Higher drift risk
- More cleanup and retention decisions
- Can create false confidence if snapshots go stale

## Chosen Approach

Use the **Ops Mirror** approach.

It gives enough structure to start debugging immediately, while avoiding a brittle 1:1 copy of the actual OpenClaw installation. The workspace will hold durable operational knowledge and reusable scripts, but the source of truth remains the live OpenClaw paths.

## Architecture

The repo will be a documentation-and-tooling workspace with three layers:

1. **Entry layer**
   - `README.md` for the first 60 seconds of an outage
   - concise quick-start commands and escalation path

2. **Knowledge layer**
   - `docs/runbook.md` for incident flow
   - `docs/architecture.md` for runtime topology, paths, and moving parts
   - optional `docs/known-facts.md` if facts grow beyond the runbook

3. **Execution layer**
   - `scripts/healthcheck.sh` for quick service validation
   - `scripts/collect-diagnostics.sh` to snapshot status, config metadata, logs, and process state into a timestamped incident folder
   - `scripts/follow-logs.sh` as a stable wrapper around the canonical log command

Incident-specific output will be stored under `incidents/` so that future failures accumulate structured evidence instead of ad hoc terminal history.

## Data Flow

### Health Check

`scripts/healthcheck.sh` should:

- verify the OpenClaw CLI is available
- run `openclaw gateway status`
- confirm the config file exists
- confirm the workspace root exists
- print the known dashboard and RPC endpoints
- exit non-zero when core prerequisites fail

### Diagnostics Collection

`scripts/collect-diagnostics.sh` should create a timestamped incident directory and capture:

- `openclaw gateway status`
- current date and hostname
- process snapshot for the gateway
- config file metadata, not secrets-heavy full dumps unless explicitly enabled
- the latest runtime log tail
- a short environment summary with the confirmed key paths

### Log Following

`scripts/follow-logs.sh` should provide one stable command for the most useful live logs path, defaulting to `openclaw logs --follow`.

## Error Handling

- Scripts should use `set -euo pipefail`
- Missing prerequisites should produce short, actionable messages
- Diagnostics collection should continue best-effort for non-critical substeps so one failed probe does not drop the entire incident bundle
- Sensitive content should be minimized by default; prefer metadata over raw config dumps unless explicitly requested

## Testing Strategy

The workspace should include lightweight shell-based validation:

- `bash -n` syntax checks for all scripts
- small smoke tests under `tests/` that mock or override commands where possible
- at minimum, tests for file layout, healthcheck output contract, and diagnostics directory creation

The goal is not full system simulation. The goal is to keep the incident tooling itself reliable enough that it does not fail when needed.

## Non-Goals

- Rebuilding or vendoring the real OpenClaw source tree into this repo
- Managing the OpenClaw service lifecycle beyond documented commands
- Storing secrets or large runtime artifacts by default
- Replacing the live OpenClaw workspace at `/Users/hulki/.openclaw/workspace`

## Success Criteria

This workspace is successful when:

- a future outage can be approached from this folder alone
- the first responder does not need to rediscover paths, ports, or log locations
- one command can run a useful health check
- one command can collect a timestamped diagnostic bundle
- the docs reflect the currently known local OpenClaw topology

## Implementation Note

This directory is not yet a Git repository. The implementation plan should therefore include bootstrap steps for `git init`, ignore rules, and the first commit so the operations workspace becomes durable immediately.
