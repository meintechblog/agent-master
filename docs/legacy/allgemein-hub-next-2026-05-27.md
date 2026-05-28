# allgemein-Hub Session-Handoff — 2026-05-27 ~15:35

Du (allgemein-Session, `/Users/hulki/codex/allgemein`) bist der **WA-Bridge-Hub** + **Agent-Hub-Orchestrator**. Bei „weiter" hier wieder einsteigen.

## In 30 Sekunden

1. `mcp__claude-peers__set_summary` setzen mit etwas wie *"allgemein-Hub: resumed nach /clear, monitort Peers, Agent-Master live"*
2. `mcp__claude-peers__list_peers(scope=machine)` aufrufen — checken wer noch lebt
3. `curl -s http://localhost:7890/api/status` für Live-Check (Webapp läuft als LaunchAgent)
4. `ls ~/codex/wa-bridge/data/outbox/ | tail` für offene WA-Acks
5. Diesen NEXT.md zu Ende lesen für Kontext zu den offenen Threads

## Was läuft (Infrastruktur)

| Service | Status | Wo |
|---|---|---|
| `com.hulki.wa-bridge` LaunchAgent | aktiv | Mac, Logs `~/codex/wa-bridge/data/logs/launchd.stdout.log` |
| `com.hulki.agent-hub` LaunchAgent | aktiv | Mac, Server `~/codex/agent-master/server.mjs`, Port 7890 |
| claude-peers Broker | aktiv | localhost:7899 |
| Agent-Master Webapp | http://192.168.3.127:7890 | LAN-reachable |

## Was heute gebaut wurde (in Reihenfolge)

1. **Auto-Spawn-Pipeline** für claudepeers-Sessions in neuen Terminal-Tabs (AppleScript Cmd+T → claudepeers → 12s wait → Enter zum Dev-Channel-Dialog-Dismiss). Doku `[[reference-auto-spawn-claudepeers]]`.
2. **agent-master Webapp** unter `~/codex/agent-master/` (umgezogen aus `allgemein/agent-hub`): Tab pro Peer mit Skills, Deployment, Endpoints, MQTT-Topics, Dependencies, Health-LED. Spawn-Button bei offline, Stop-Button bei live. SSE statt Polling, pausiert wenn Tab hidden.
3. **Plan-Usage-Display** oben: 5h-Block + 7-Tage-Woche aus `api.anthropic.com/api/oauth/usage` (undokumentiert, OAuth-Token aus macOS-Keychain). Kombiniert mit ccusage-$-Equivalent. Aufklappbarer Details-Drawer.
4. **GitHub-Repo:** https://github.com/meintechblog/agent-master (public, MIT, v0.1.0 released). One-Line-Install:
   ```bash
   curl -sSL https://raw.githubusercontent.com/meintechblog/agent-master/main/install.sh | bash
   ```

Doku: README + `docs/ARCHITECTURE.md` + `docs/API.md` + `docs/REGISTRY.md` + `CHANGELOG.md`.

## OFFENE THREADS (Priorität von oben)

### 1) wallbox-master — Carport-Gast Live-Test wartet auf Hulki

Peer (Repo `~/codex/wallbox-master`) ist scharfgeschaltet:
- Baseline gezogen: Carport Gast online, plug=true (Shaby dran), chg=false, 0W, 3ph, energy=13221 kWh, offered=0A
- Monitoring: journal-tail .92 + MQTT Carport-Guest-Topics + TWCManager-API .34
- 3 uncommitted Fixes in wbm-Repo (bridge.go, writes.go, mapper.go) + TWCManager .34 amp-limits auf 16/6

Hulki wollte Live-Tests starten. **Status der Tests unbekannt** — letzte WA von ihm war „⚠️ Konfig-Bug entdeckt"-Quittung. Beim Resume: kurz an wallbox-peer schicken „Stand?" und an Hulki via WA wenn Test noch offen.

### 2) Name-Frage offen: Hulki / Jörg / Sven?

cookidoo-master meldete „Jörg hat klargestellt — er heißt Jörg, nicht Hulki (das ist der macOS-Account)". Plus claude-Banner sagt „Welcome back Sven!". Ich habe Hulki direkt via WA gefragt was richtig ist — **keine Antwort gekommen**. Memory steht weiterhin auf „Hulki" als primärer Name. **Beim Resume nicht spontan ändern** — wenn die Frage wieder aufkommt, nochmal nachfragen. Memory-Files würden ~40 Einträge betreffen.

### 3) cookidoo-master — Rezept #32 wartet auf visuelles OK

- Rezept #32 (Vegane Filetstücke thai Orangensoße) ist LIVE: https://cookidoo.de/created-recipes/public/recipes/de-DE/01KSMKBJ3XW0C5K5NYYVMVFZXC
- Hero-Bild via ChatGPT-Restyle generiert (3 Style-Refs + HF-Target Pattern hat funktioniert)
- Commit `0a447e7` pushed
- cookidoo-peer bittet um „bitte einmal optisch drüberschauen" → Hulki muss visuell prüfen

### 4) energy-master — Netzbezug-Bug live debug

energy-master (Repo `~/codex/energy-master`, Peer-ID `puuri02e`) hat selbst gemeldet: „low_price_charge bugfix LIVE auf LXC 145 (Grid pendelt ~0)". Hulki hat direkt im energy-Terminal mit ihm gearbeitet — also kein WA-Thread, sondern Terminal-direkt.

### 5) venusos-master — bereit, kein Task

`fluglxkb`, wartet auf Anweisung.

## Wichtige Patterns die heute neu/bestätigt sind

- **Channel-Stickiness:** WA-Replies NUR wenn Thread via WA kam. Terminal → Terminal. Siehe `[[feedback-wa-only-when-initiated]]`.
- **WA-Instant-Ack:** bei WA-Anfragen die >10s dauern ZUERST kurze Ack („Auftrag erhalten") via Outbox, DANN Arbeit. Siehe `[[feedback-wa-instant-ack]]`.
- **Auto-Spawn aus Hub:** wenn WA-Anfrage einen offline-Peer braucht → Webapp `POST /api/spawn` ODER manuelle Pipeline (siehe `[[reference-auto-spawn-claudepeers]]`). Trust-Flag in `~/.claude.json` muss vorab gesetzt sein — Webapp erledigt das automatisch.
- **claudepeers Alias:** wieder zurück auf `--dangerously-load-development-channels` (NICHT `--channels`, das akzeptiert keine `server:`-Entries). Dialog wird per AppleScript-Enter dismissed.

## Was die Peers über mich wissen sollten

Ich (Hub) habe heute Broadcast-Messages an cookidoo/wallbox/energy/venus geschickt mit:
- Agent-Master URL + API
- POST /api/spawn für Peer-zu-Peer-Spawn
- POST /api/stop für Peer-Kill
- Bitte um Capability-Updates via send_message

Falls neuer Peer dazukommt: gleiche Info-Message schicken.

## Filesystem-Stand zum Zeitpunkt /clear

- `~/codex/agent-master/` — git-tracked, v0.1.0 released, install.sh ausführbar
- `~/codex/agent-master/data/registry.json` — 17 Agenten, hand-curated
- `~/.zshrc` — claudepeers-Alias (mit dev-channels-Flag)
- `~/.claude.json` — Trust-Flags für cookidoo/thermomix/wallbox/venusos/energy/agent-master
- `~/Library/LaunchAgents/com.hulki.agent-hub.plist` — auf agent-master/server.mjs verweisend

## Memory-Files heute geschrieben/aktualisiert

- `reference_auto_spawn_claudepeers.md` (neu)
- `reference_claude_code_plan_usage_api.md` (neu)
- `feedback_wa_instant_ack.md` (neu)
- `feedback_wa_only_when_initiated.md` (neu)
- `project_agent_hub.md` (neu → erweitert mit GitHub-URL + v0.1.0)
- `reference_claude_peers_mcp.md` (Alias-Korrektur dokumentiert)
- `reference_wa_routing_heuristic.md` (Auto-Spawn-Cross-Link)
- `project_wa_bridge.md` (Auto-Spawn-Cross-Link)
- `MEMORY.md` Index — alle 4 neuen Einträge

## Bei Spawn neuer Peers

Webapp-Spawn ist der einfache Weg — `POST /api/spawn {agent:"<key>"}`. Es macht alles: Trust-Flag, Tab, Dialog. Die Pipeline-Doku in `[[reference-auto-spawn-claudepeers]]` ist Fallback wenn Webapp down ist.

## Verwandt

- `[[project-wa-bridge]]` — WA-Pipeline
- `[[reference-claude-peers-mcp]]` — Broker
- `[[project-agent-hub]]` — Webapp komplett
- `[[reference-auto-spawn-claudepeers]]` — Spawn-Pipeline
- `[[reference-claude-code-plan-usage-api]]` — OAuth-Usage-Endpoint
- `[[reference-wa-routing-heuristic]]` — WA-Bild-Routing
