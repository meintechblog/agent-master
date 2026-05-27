#!/usr/bin/env bash
# agent-master — one-line installer for macOS
#
#   curl -sSL https://raw.githubusercontent.com/meintechblog/agent-master/main/install.sh | bash
#
# Idempotent. Re-running upgrades in place.
# Uninstall: bash install.sh --uninstall

set -euo pipefail

REPO_URL="${AGENT_MASTER_REPO:-https://github.com/meintechblog/agent-master.git}"
INSTALL_DIR="${AGENT_MASTER_DIR:-$HOME/codex/agent-master}"
PORT="${AGENT_HUB_PORT:-7890}"
PLIST_LABEL="${AGENT_HUB_LABEL:-com.${USER}.agent-hub}"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
ZSHRC="$HOME/.zshrc"
ALIAS_LINE="alias claudepeers='claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers'"

# ── ANSI ─────────────────────────────────────────────────────────────────────
c_blue='\033[1;34m'
c_green='\033[1;32m'
c_yellow='\033[1;33m'
c_red='\033[1;31m'
c_dim='\033[2m'
c_off='\033[0m'

log()  { printf "${c_blue}▶${c_off} %s\n" "$*"; }
ok()   { printf "${c_green}✓${c_off} %s\n" "$*"; }
warn() { printf "${c_yellow}!${c_off} %s\n" "$*"; }
err()  { printf "${c_red}✗${c_off} %s\n" "$*" >&2; }

# ── Uninstall path ───────────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" ]]; then
  log "Uninstalling agent-master…"
  if [[ -f "$PLIST_PATH" ]]; then
    launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    ok "LaunchAgent removed."
  fi
  warn "Repo at $INSTALL_DIR left in place (rm -rf manually if you want)."
  warn "claudepeers alias in $ZSHRC left in place (delete the line manually if you want)."
  exit 0
fi

# ── Sanity ───────────────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Darwin" ]]; then
  err "macOS only (uses AppleScript + launchd). Detected: $(uname -s)"
  exit 1
fi

# ── Node ─────────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  err "node is required but not found."
  err "Install: brew install node@22  (or any node >= 18)"
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  err "node $NODE_MAJOR is too old (need >= 18). Upgrade and re-run."
  exit 1
fi
ok "node detected: $NODE_BIN (v$(node -p 'process.versions.node'))"

# ── git ──────────────────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  err "git is required. Install Xcode Command Line Tools: xcode-select --install"
  exit 1
fi

# ── Clone / pull repo ────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Repo exists at $INSTALL_DIR — pulling latest."
  git -C "$INSTALL_DIR" pull --ff-only
  ok "Repo updated."
elif [[ -d "$INSTALL_DIR" ]]; then
  warn "$INSTALL_DIR exists but is not a git repo."
  warn "Leaving in place (assume in-repo invocation). To re-clone: rm -rf $INSTALL_DIR && re-run."
else
  log "Cloning $REPO_URL → $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned."
fi

mkdir -p "$INSTALL_DIR/data"

# Seed registry from example on first install. User edits this file directly afterwards.
if [[ ! -f "$INSTALL_DIR/data/registry.json" ]]; then
  cp "$INSTALL_DIR/data/registry.example.json" "$INSTALL_DIR/data/registry.json"
  ok "Seeded data/registry.json from example. Edit it to register your own agents."
fi

# ── claudepeers alias ────────────────────────────────────────────────────────
if [[ -f "$ZSHRC" ]] && grep -qE '^alias claudepeers=' "$ZSHRC"; then
  ok "claudepeers alias already in $ZSHRC"
else
  log "Adding claudepeers alias to $ZSHRC"
  {
    echo ""
    echo "# claude-peers-mcp — added by agent-master installer"
    echo "$ALIAS_LINE"
  } >> "$ZSHRC"
  ok "Alias appended. Open a new terminal or 'source $ZSHRC' to use it."
fi

# ── LaunchAgent plist ────────────────────────────────────────────────────────
log "Writing LaunchAgent plist → $PLIST_PATH"
mkdir -p "$(dirname "$PLIST_PATH")"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${INSTALL_DIR}/server.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/data/server.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/data/server.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>AGENT_HUB_PORT</key>
        <string>${PORT}</string>
    </dict>
</dict>
</plist>
PLIST
ok "Plist written."

# Reload (works whether previously loaded or not)
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"
sleep 2

# ── Smoke-test ───────────────────────────────────────────────────────────────
log "Smoke-testing http://localhost:${PORT}/api/status"
for i in 1 2 3 4 5; do
  if curl -sf "http://localhost:${PORT}/api/status" >/dev/null 2>&1; then
    ok "Server responds."
    break
  fi
  sleep 1
  if (( i == 5 )); then
    err "Server didn't respond after 5s. Check ${INSTALL_DIR}/data/server.stderr.log"
    exit 1
  fi
done

# ── Done ─────────────────────────────────────────────────────────────────────
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 'localhost')"
printf "\n${c_green}━━━ agent-master is live ━━━${c_off}\n"
printf "  Local:  ${c_blue}http://localhost:${PORT}${c_off}\n"
[[ "$LAN_IP" != "localhost" ]] && printf "  LAN:    ${c_blue}http://${LAN_IP}:${PORT}${c_off}\n"
printf "  Restart:  launchctl kickstart -k gui/\$(id -u)/${PLIST_LABEL}\n"
printf "  Logs:     tail -f ${INSTALL_DIR}/data/server.stdout.log\n"
printf "  Uninstall: bash ${INSTALL_DIR}/install.sh --uninstall\n\n"
