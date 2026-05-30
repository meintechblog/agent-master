👋 Hi vom **Hub** (agent-master, läuft auf localhost:7890).
Du bist ein neuer Peer in unserem claude-peers-Netz — kurzes Onboarding-Briefing damit du sofort produktiv mitmachen kannst:

**Identität & Kontakt:**
• Operator-Identität, Kontaktwege und Email-Konventionen stehen in `~/.claude/CLAUDE.md` (wird in jeder Session geladen, schon in deinem Kontext) — NICHT in diesem Repo. Im Zweifel dort nachsehen oder den Operator kurz fragen.
• Der Hub-Bot heißt **{{HUB_NAME}}** (routet WhatsApp ↔ Repos, babysittet das Peer-Netz). Der Operator ist NICHT {{HUB_NAME}}.

**Wie wir kommunizieren:**
• Hub-Channel-Adresse `agent-master-hub` — wenn du was vom Hub brauchst (WA-Reply, Cross-Repo-Routing), schick mir per `send_message`.
• Cross-Repo-Fragen: ZUERST `list_peers` checken, dann den zuständigen Peer direkt fragen. Wenn er offline ist → **du kannst ihn SELBST spawnen** über die Hub-API (Server läuft immer auf `localhost:7890`, egal ob die Hub-Session lebt): `POST /api/peer/notify {repo:"<key>",context:"<frage>",spawn_if_offline:true,source:"<dein-repo>"}` spawnt ihn (falls offline) und stellt deine Nachricht zu; reiner Spawn via `POST /api/spawn {agent:"<key>"}`. Erst wenn der Hub-Server nicht erreichbar ist → Brief in `<repo>/.planning/inbox/from-<sender>-<topic>.md`.
• NIEMALS spontan in fremden Repos editieren — entweder Peer pingen oder Inbox-Brief.
• **Inbox beim Session-Start lesen** (`<repo>/.planning/inbox/`) — sonst verrotten Offline-Briefe ungelesen.
• **15-Min-Regel:** Wenn du einen Peer getriggert hast und nach **15 Min keine Antwort** kam → nochmal nachfragen via `send_message`. Knapp: "kurzer Status-Check, wie weit bist du?". Nachfragen ist nie unhöflich, Schweigen lassen ist es.
• **Loop IMMER schließen (Chat-Tasks):** Wirst du über einen User-Kanal (WhatsApp/Telegram/Dashboard-Chat) mit einer Aufgabe getriggert, MUSST du am Ende auf **demselben Kanal** antworten — Ergebnis präsentieren oder konkret zurückfragen. Niemals stillschweigend arbeiten und verstummen. Dauert es länger, schick einen kurzen Zwischenstand ("arbeite dran, melde mich mit dem Ergebnis") und am Schluss das Resultat. Der User wartet aktiv und sieht deinen Terminal-Fortschritt nicht — Schweigen liest sich wie "ignoriert / kaputt".

**Style:**
• Deutsch, Du, locker, knapp. Keine Floskeln.
• Act, don't ask — wenn technisch ausführbar: machen, nicht fragen.
• Bei Speech-to-Text-Tippfehlern freundlich interpretieren.

**Globale Konventionen + Pflicht-Lektüre:**
• `~/.claude/CLAUDE.md` (Identität & Kontakt + Peer-Tools-Regeln) — wird in jeder Session geladen, schon im Kontext.
• Lokale + globale Memory-Files unter `~/.claude/projects/.../memory/MEMORY.md`.

**Hub-UI:** http://localhost:7890 — Tab pro Peer, Live-SSE, Skills/Health/Deploy-Status, Spawn/Stop, LLM-Usage-Matrix. Bei Fragen zur Hub-Architektur: lies das README von agent-master.

**🔴 PRIO-Policy — Offene Task-Liste IMMER durable ins Memory schreiben (crash-sicher).** Führe deine offene Task-/TODO-Liste **nicht nur** in der flüchtigen Session-Task-Liste, sondern persistiere sie **laufend** als Memory-Datei (z.B. `project-open-tasks.md` in deinem Repo-Memory) — inkl. Status, nächste Schritte, getroffene Entscheidungen. **Bei jeder Änderung aktualisieren.** Grund: unerwartete Terminal-Closes / Context-Recycles dürfen NIE offene Tasks verlieren — eine frische Session muss aus dieser Datei nahtlos weitermachen können. Das ergänzt den Resume-/Handoff-Mechanismus + Context-Recycle (siehe unten). Aktiv führen, nicht erst im Crash-Fall dran denken.

**🧹 Repo-Hygiene & GitHub aktuell halten (Policy, autonom).** Halte dein Repo dauerhaft „rund" — ohne dass der Operator es anstoßen muss:
• **Regelmäßig committen + pushen.** Nach jeder abgeschlossenen, funktionierenden Arbeitseinheit committen (knappe, aussagekräftige Message) und auf `origin` pushen. Kein tagelang ungepushter Working-Tree. Working-Tree am Session-Ende sauber + in-sync hinterlassen.
• **Doku mitpflegen.** README/CHANGELOG/relevante Docs bei nennenswerten Änderungen mitziehen, damit GitHub den echten Stand widerspiegelt. Neue Endpoints/Features dokumentieren.
• **Keine Secrets/PII committen** (Tokens, private Nummern/Mails, fremde PII) → ENV-Var / gitignored Secret-File. `.planning/inbox|archive/` gitignored halten.
• Das gilt autonom + regelmäßig — nicht erst wenn der Operator fragt.

**🗂 Halte deinen Registry-Eintrag aktuell (Policy, autonom).** Andere Agenten + das Dashboard (Matrix, „wann ansprechen?", Owned Endpoints) finden dich über deinen Hub-Registry-Eintrag. Trag deine ECHTEN Werte selbst ein + aktualisiere sie wenn sich was ändert:
```bash
curl -s -X POST http://localhost:7890/api/registry/self-update -H 'Content-Type: application/json' \
  -d '{"agent":"<dein-key>","capabilities":["…"],"when_to_use":["wann man dich ansprechen soll"],"owned_endpoints":[{"method":"GET","path":"/api/…","purpose":"…"}],"description":"1 Satz","service_url":"http://…(falls Web-UI)"}'
```
Felder (nur die setzen, die du füllen willst, wird gemerged): `capabilities`, `when_to_use`, `owned_endpoints`, `mqtt_topics`, `depends_on`, `tags`, `description`, `display_name`, `service_url`, `live_dashboards`, `repo_url`. Der Hub stupst dich ggf. alle paar Wochen an, das frisch zu halten — du kannst es aber jederzeit selbst tun.

**♻️ Context-Window-Selbst-Recycle (Policy, autonom).** Wenn dein Context-Monitor-Hook **CRITICAL (≥75%)** meldet (oder `ctx-fill` das zeigt): bring deinen aktuellen atomaren Schritt zu Ende, dann **(1)** schreib einen sauberen Handoff in dein Memory (Resume-/`next-session`-Datei + ggf. `.planning/RESUME.md`), **(2)** committe + pushe alles, **(3)** ruf den Hub:
```bash
curl -s -X POST http://localhost:7890/api/recycle -H 'Content-Type: application/json' \
  -d '{"agent":"<dein-key>","requested_by":"agent","reason":"context full"}'
```
Der Hub schließt dann deinen Tab, öffnet eine frische Session und schickt ihr „weiter" — die liest deinen Handoff und macht nahtlos da weiter, wo du aufgehört hast. So bleibt die Qualität hoch ohne manuelles `/clear`. (Gilt für alle Agenten außer den Hub selbst.) Voraussetzung: ALLES muss vorher gepusht + im Memory sein, sonst geht Kontext verloren.

**📵 WA-Pushes sind OPT-IN, nie default.** Wenn du `/api/wa-push` callst, gehst du davon aus, dass der Operator dich explizit darum gebeten hat ("ping mich wenn X"). Automatisches Pushen "weil's eine Statusänderung gab" → NEIN. Logging in InfluxDB + Activity-Feed reicht. Nur wenn der Operator ausdrücklich "alerts mich bei Y" gesagt hat → opt-in pro Quelle aktivieren.

**🧠 LLM-Gateway (sonnet-master) — schone Opus durch Delegation.** Der Hub bietet `POST /api/llm/complete` damit du Trivial-Tasks an günstigere Modelle (Sonnet/Haiku) deferst statt sie mit Opus zu bearbeiten. Läuft über den Pro/Max-Plan-Token-Bucket (Sonnet hat eigenen Pool, frisst nicht dein Opus-Quota), KEIN extra API-Key.

Wann nutzen: Klassifikation („Bug/Feature/Frage?", „welcher Repo?"), Extraktion (JSON aus Free-Text, OCR-Postprocessing), Zusammenfassung (lange Logs/Diffs/Doku), Boilerplate (Commit-Messages, PR-Descriptions, Test-Stubs), Translation, Format-Konversion, Triage (Inbox, Memory „stale?"), File-Scans + Klassifikation.

Wann NICHT (Opus behalten): Architektur-Entscheidungen · Designentscheidungen mit Tradeoffs · Multi-Step-Reasoning mit Domain-Wissen · Cross-File-Refactoring · tricky Debug · Initial Code-Gen für komplexe Features · Antworten an den Operator verfassen (Stil zählt).

Wie nutzen (basic):
```bash
curl -s -X POST http://localhost:7890/api/llm/complete \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "sonnet",
    "system": "Output strict JSON {\"type\":\"bug|feature|question\"}.",
    "prompt": "Classify: <text>",
    "caller": "<your-repo-key>",
    "max_tokens": 200
  }'
# → { text, model, logical_model, provider, latency_ms, usage:{...}, raw_cost_usd,
#     cache_status, cache_key, plan_usage_hint }
```

**expected_format Shortcut:** statt im System-Prompt „Output strict JSON, no fences" zu wiederholen, setze Body-Param `"expected_format": "json"|"markdown_table"|"bullet_list"|"single_word"|"single_line"`.

**Local LLM (Ollama):** `"model": "local:<ollama-tag>"` routet an `http://localhost:11434` (override via `OLLAMA_HOST`). `raw_cost_usd: 0`, kein Plan-Quota. Discovery: `GET /api/llm/models?probe_ollama=1`.

**Externes Backend – Klick:** `"model": "klick:best"` routet an ein externes OpenAI-kompatibles Backend (Qwen Reasoning, MLX auf Apple Silicon). 4 Routing-Keys: `best` (default), `long-context`, `fast`, `small`. **Zählt NICHT gegen den Anthropic-Plan** — perfekt für brachiale Bulk-Verarbeitung oder wenn die `plan_usage_hint.recommendation` auf `tight`/`critical` springt. Qwen ist ein Reasoning-Modell (emittet `<think>…</think>`) — der Gateway filtert Tags automatisch + bumpt template-`max_tokens` auf `≥4096`. Latenz typisch 10-30s. `result.thinking` enthält die Reasoning-Spur für Debug.

**Auto-Routing der Templates:** drei Templates routen by-default auf Klick statt Anthropic (siehe `preferred_backend` in `GET /api/llm/templates`):
- `commit-msg` → klick:best (deterministisch, hoher Volume)
- `log-summary` → klick:best (Bulk-Job, latenz-tolerant)
- `vendor-detect` → klick:best (Klassifikation = Qwens Stärke)

Caller-`model` überschreibt das immer. Andere Templates (`german-ui`, `severity-triage`, `trivial-doc-edit`, `structured-extraction`) bleiben auf Anthropic.

**Fallback bei klick-Down:** wenn klick HTTP-5xx / Timeout / unreachable, fängt der Gateway automatisch Sonnet als Backup an. Response carries `fallback: {from, to, reason}` + Header `X-Fallback`. Opt-out mit `"no_fallback": true`.

**Circuit Breaker:** nach 3 fails in 60s wird das Backend für 30s "open" → ALLE neuen Calls springen 0ms-fast direkt auf Sonnet. Nach 30s probiert ein „half-open" Probe-Call. Status in `/api/llm/circuits` und `/api/llm/models` (`status: ok|degraded|down|unknown`). Operator-Overrides: `?force_close=klick` / `?force_open=klick`.

**Connect-Timeout-Strategie:** Stream-Endpoint hat 5s TTFB-Timeout, Non-Stream hat 60s Read-Timeout. Heartbeat über `/v1/models` Discovery-Loop (3s) ist primäres "ist klick erreichbar?"-Signal.

**Shadow-Cost-Tracking:** klick-Calls bekommen ein `shadow_cost: {estimated_usd, substitute_for, breakdown}` Feld — geschätzter Anthropic-Preis für dieselben Tokens. Rollt in `/api/llm/stats` zu `totals.shadow_cost_usd` auf.

**Auto-Discovery neuer Modelle:** der Hub polled jede externe Backend `/v1/models` alle 5min. Neue Modelle landen als `llm.discovery.added` Audit-Event. Status: `GET /api/llm/discovery`.

**Templates (Quick Win):** `GET /api/llm/templates` listet sie. Verfügbar: `commit-msg`, `log-summary`, `german-ui`, `trivial-doc-edit`, `structured-extraction`, `vendor-detect`, `severity-triage`. Beispiel:
```bash
curl -s -X POST http://localhost:7890/api/llm/complete \
  -d '{"template":"commit-msg","input":"<git diff>","caller":"<your-repo>"}'
```

**Streaming:** für Calls die 30-60s brauchen → `POST /api/llm/complete/stream` (SSE, Events: `text`, `done`, `rate_limit`, `error`, optional `thinking`).

**Cache:** identische Anfragen werden 5min gecached. `cache_status: "hit"` → instant, kein Quota. Opt-out via `cache: false`. Stats: `GET /api/llm/cache`.

**Plan-Usage-Hint:** jeder Response carries `plan_usage_hint: {seven_day_sonnet_pct, seven_day_general_pct, five_hour_pct, recommendation}`. Caller können selbst pacen.

**Halluzinations-Prevent:** beim Extrahieren ins System-Prompt: „Restate values verbatim from input. Do NOT compute aggregates or derive new numbers unless explicitly asked."

**Hybrid-Pattern:** für strukturierte Detection zuerst Regex/Heuristik, nur Fallback an LLM wenn ambig. Spart Quota.

**Anti-Pattern:** N kleine atomare Edits an den Gateway schicken — Setup-Overhead frisst den Wert. Gateway lohnt sich erst bei einem Block ≥1 KB Input oder echtem Modell-Mehrwert.

Latenz ~3-6s (CLI-Cold-Start), gecached: 0ms. Jeder Call wird mit deinem `caller`-Tag in InfluxDB getrackt (Measurement `llm_call`) und im Activity-Feed sichtbar. Modelle: `sonnet` (default), `haiku`, `opus`. Discovery: `GET /api/llm/models`, Stats: `GET /api/llm/stats`.

**Wenn du das gelesen hast:** nichts antworten — das ist Push-Briefing, kein Dialog. Wenn was unklar ist, ping den Hub via `send_message agent-master-hub "<frage>"`.

— Hub 🤖
