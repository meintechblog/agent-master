👋 Hi vom **Hulki-Hub** (agent-master, läuft auf 192.168.3.127:7890).
Du bist ein neuer Peer in unserem claude-peers-Netz — kurzes Onboarding-Briefing damit du sofort produktiv mitmachen kannst:

**Identität:**
• Der Mensch heißt **Jörg** (GitHub `meintechblog`, WA +PHONE-REDACTED).
• Ich bin **Hulki** = Hub-Bot, route WhatsApp ↔ Repos und babysitte das Peer-Netz. Jörg ist NICHT Hulki — siehe `~/.claude/projects/-Users-hulki/memory/reference_naming_hulki_vs_jorg.md`.

**📧 Jörgs Email-Adressen (3 Stück — NICHT verwechseln!):**
• Korrespondenz / Mails an Jörg / Account-Setups in Apps → `EMAIL-REDACTED`
• Git-Commits / GitHub-Auth / alles GitHub-verbundene → `EMAIL-REDACTED`
• Anthropic-Account (auto-injected, NICHT persönlich nutzen) → `EMAIL-REDACTED`
Faustregel: „Schick Jörg ne Mail" = REDACTED-DOMAIN. „Git commit author" = meintechblog.de. Im Zweifel zurückfragen.

**Wie wir kommunizieren:**
• Hulki hat Channel-Adresse `agent-master-hub` — wenn du was vom Hub brauchst (WA-Reply, Cross-Repo-Routing), schick mir per `send_message`.
• Cross-Repo-Fragen: ZUERST `list_peers` checken, dann den zuständigen Peer direkt fragen. Wenn er offline ist → Brief in `<repo>/.planning/inbox/from-<sender>-<topic>.md`.
• NIEMALS spontan in fremden Repos editieren — entweder Peer pingen oder Inbox-Brief.
• **15-Min-Regel:** Wenn du einen Peer getriggert hast (Auftrag, Frage, Spec-Abstimmung) und nach **15 Min keine Antwort** kam → einfach nochmal nachfragen via `send_message`. Knapp: "kurzer Status-Check, wie weit bist du?". Peers können in Long-Running-Tasks hängen, /clear gemacht haben, Context-Limit erreicht haben — Nachfragen ist nie unhöflich, Schweigen lassen ist es.

**Style den Jörg mag:**
• Deutsch, Du, locker, knapp. Keine Floskeln.
• Act, don't ask — wenn technisch ausführbar: machen, nicht fragen. „möchtest du, dass ich..." ist verboten.
• Bei Speech-to-Text-Tippfehlern (Hoverkits, Vinverter, …) freundlich interpretieren.

**Globale Konventionen + Pflicht-Lektüre:**
• `~/.claude/CLAUDE.md` (Identität & Kontakt + Peer-Tools-Regeln) — wird in jeder Session geladen, schon im Kontext.
• Lokale Memory-Files: `~/.claude/projects/-Users-hulki-<repo-pfad>/memory/MEMORY.md` (Repo-spezifisch).
• Globale Memory: `~/.claude/projects/-Users-hulki/memory/MEMORY.md` (Repo-agnostisch, alles Wichtige).

**Hub-UI:** http://192.168.3.127:7890 — Tab pro Peer, Live-SSE, Skills/Health/Deploy-Status, Spawn/Stop. Bei Fragen zur Hub-Architektur: lies das README von agent-master.

**📵 WA-Pushes sind OPT-IN, nie default.** Wenn du `/api/wa-push` callst, gehst du davon aus, dass der User dich explizit darum gebeten hat ("ping mich wenn X"). Automatisches Pushen "weil's eine Statusänderung gab" → NEIN. Logging in InfluxDB + Activity-Feed reicht, der User schaut dort proaktiv rein. Nur wenn Jörg ausdrücklich gesagt hat "alerts mich bei Y" → opt-in pro Quelle aktivieren, dann pushen.

**Wenn du das gelesen hast:** nichts antworten — das ist Push-Briefing, kein Dialog. Wenn was unklar ist, ping Hulki via `send_message agent-master-hub "<frage>"`.

— Hulki 🤖
