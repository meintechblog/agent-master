# Agent-Regeln — Playbook

> Standard für den **📋 Regeln**-Tab im Hub-Dashboard (`:7890`). Jeder Agent
> dokumentiert hier strukturiert, **nach welchen Regeln er Nachrichten/Events
> routet und behandelt** — damit der Operator auf einen Blick versteht, wie sich
> ein Agent verhält, und andere Agenten es nachvollziehen können.
>
> Dieses Playbook ist verbindlich für ALLE Agenten, die Regeln eintragen.
> Kanonische Quelle; bei Unklarheit gilt diese Datei.

## 0. TL;DR (in 30 Sekunden)

1. **Eine Regel = ein Verhalten.** Atomar. Kein Absatz, keine Mehrfach-Regel.
2. **WENN → DANN.** `condition` = der Auslöser, `action` = was du dann TUST. Konkret, im Imperativ.
3. **Beschreibe, was du WIRKLICH tust** — nicht, was du tun solltest. Kein Wunschdenken.
4. **Immer `source` angeben** (Code-Ref `pfad:zeile` / CLAUDE.md-Abschnitt / URL). Eine Regel ohne Quelle ist nicht wartbar.
5. **`priority`: kleiner = wichtiger.** Safety/harte Regeln 1–9, normal 10–99, nice-to-have 100+.
6. **Declarativ posten:** du sendest IMMER deine KOMPLETTE Liste, sie ersetzt den ganzen Satz. Bei Verhaltensänderung re-posten, veraltete Regeln entfernen.
7. **Keine Secrets/PII** in Regeln (Tokens, private Nummern/Mails, fremde PII).

## 1. Wie du postest

```bash
curl -s -X POST http://localhost:7890/api/agent-rules/self-update \
  -H 'Content-Type: application/json' \
  -d '{
    "agent": "<dein-key>",
    "display_name": "<optional, wie du im Tab heißt>",
    "rules": [ { ...Rule... }, { ...Rule... } ]
  }'
```

- **Idempotent / declarativ:** der Post **ersetzt** deinen kompletten Regel-Satz (wie `registry/self-update`). Du ownst deine Liste vollständig — also immer die ganze Liste schicken, nicht einzelne Regeln nachreichen.
- **Lesen:** `GET /api/agent-rules?agent=<key>` (nur du) bzw. `GET /api/agent-rules` (alle).
- **Pflegen:** wenn sich dein Verhalten ändert (neuer Code-Pfad, neue Policy), re-poste. Lösch Regeln, die nicht mehr stimmen — eine falsche Regel ist schlimmer als keine.

## 2. Das Rule-Schema (Feld für Feld)

| Feld | Pflicht | Konvention |
|---|---|---|
| `id` | empfohlen | Stabiler kebab-case-Slug (`prefixless-to-brain`). Stabil halten über Re-Posts, damit eine Regel identifizierbar bleibt. Fehlt er, wird er aus Titel/Index abgeleitet. |
| `title` | **ja** | Kurze Substantiv-Phrase, ≤ ~60 Zeichen (`„Prefixlos → Brain"`). Kein ganzer Satz. |
| `category` | empfohlen | Slug aus der [Taxonomie](#4-kategorie-taxonomie-empfohlen). Default `general`. |
| `condition` | eines von beiden | Der Auslöser: „WENN …". Beobachtbar + konkret (`„Nachricht ohne @agent-Prefix"`), nicht vage (`„manchmal"`). |
| `action` | eines von beiden | Was du dann TUST: „DANN …". Im Imperativ, eindeutig, eine Handlung. |
| `priority` | empfohlen | Zahl, **kleiner = wichtiger**. Siehe [Prioritäts-Bänder](#5-prioritäts-bänder). Default 100. Sortiert innerhalb der Kategorie. |
| `source` | **stark empfohlen** | Woher die Regel kommt + wo man sie verifiziert. **Bevorzugt ein STABILER Anker** (er überlebt Edits): Funktionsname `server.mjs · ensureAlwaysOnRunning()`, CLAUDE.md-Abschnitt `~/.claude/CLAUDE.md › „Channel-aware"`, oder URL. `pfad:zeile` nur, wenn nichts Stabileres existiert (Zeilen driften). |
| `example` | optional | EIN konkretes Beispiel, v.a. bei nicht-offensichtlichen Regeln (`„Wie warm ist es?" → Brain`). |
| `note` | optional | Kurzer Zusatz/Caveat/Ausnahme. Kein zweiter Regel-Body. |

Caps (Backstop gegen Abuse): max **200 Regeln/Agent**, **2000 Zeichen/Feld**.

## 3. Was eine GUTE Regel ausmacht

- **Atomar.** Hat deine `action` ein „und dann noch", ist es vermutlich zwei Regeln.
- **Beobachtbar.** Die `condition` muss aus dem realen Input erkennbar sein (ein Header, ein Prefix, ein Schwellwert), nicht aus Bauchgefühl.
- **Verifizierbar.** `source` zeigt auf die Stelle, die das Verhalten erzwingt — so kann der Operator (und das Future-You) prüfen, ob Regel und Code noch übereinstimmen.
- **Ehrlich.** Dokumentiere IST, nicht SOLL. Wenn der Code es (noch) nicht so macht, ist es keine Regel, sondern ein TODO.
- **Stabil identifizierbar.** Gleiche Regel → gleiche `id` über Re-Posts.

## 4. Kategorie-Taxonomie (empfohlen)

Frei erweiterbar (das UI rendert jede Kategorie als eigene Gruppe, alphabetisch). Aber bleib bei diesen Slugs, wo sie passen — Konsistenz über die Flotte macht den Tab lesbar:

| Slug | Wofür |
|---|---|
| `routing` | Wohin geht eine ein-/ausgehende Nachricht/Anfrage? |
| `channel` | Kanal-Verhalten (auf welchem Kanal antworten, Cross-Posting, Formatierung) |
| `forwarding` | Weiterleitung an andere Agenten/Menschen (inkl. Footer/Attribution) |
| `tickets` | Retry/Queue/Eskalation/Antwort-Latenz |
| `interaction` | Wie du mit dem Menschen interagierst (Rückfragen-Format, Disambiguierung, Bestätigungen) |
| `lifecycle` | Spawn/Stop/Recycle/Idle/Keep-Alive-Verhalten |
| `media` | Bilder/Audio/Voice/Dokumente rein & raus |
| `resilience` | Fehler/Timeout/Fallback/Degradation |
| `security` | Auth, Secrets, PII, Zugriffsgrenzen |
| `observability` | Logging, Metriken, Audit, Statusmeldungen |
| `general` | Default, wenn nichts passt |

## 5. Prioritäts-Bänder

`priority` ist eine Zahl, **kleiner = wichtiger**, sortiert die Karten innerhalb einer Kategorie.

| Band | Bedeutung |
|---|---|
| **1–9** | Harte/Safety-Regeln — Verstoß ist ein Fehler (z.B. „nie Secrets committen", „prefixlos IMMER zum Brain") |
| **10–99** | Normales Betriebsverhalten — der Alltag |
| **100+** | Nice-to-have / Stil / Feinschliff |

## 6. Gut vs. schlecht

**❌ Schlecht** (vage, nicht atomar, keine Quelle):
```json
{ "title": "Nachrichten gut behandeln", "category": "general",
  "action": "ich schaue mir Nachrichten an und mache das Richtige, manchmal leite ich weiter" }
```

**✅ Gut** (atomar, WENN→DANN, Quelle, Beispiel):
```json
{ "id": "prefixless-to-brain", "title": "Prefixlos → Brain", "category": "routing",
  "condition": "eingehende Nachricht ohne @agent/Prefix",
  "action": "immer an das Brain (chat-llm-master) zustellen, nie topic-geraten an einen anderen Agenten",
  "priority": 1, "source": "gateway/src/routing.mjs · findDefaultTarget()",
  "example": "„Wie warm ist es?" → Brain (nicht an energy-master)" }
```

## 7. Don'ts

- **Keine Secrets/PII** (Tokens, Telefonnummern, private Mails, fremde PII) — auch nicht in `example`/`note`.
- **Kein Wunschdenken** — nur dokumentieren, was der Code/dein Verhalten wirklich tut.
- **Keine Duplikate** — eine Regel pro Verhalten; widersprüchliche Regeln auflösen, nicht beide stehen lassen.
- **Kein Prosa-Dump** — `note` ist ein Satz, kein zweiter Regel-Body. Wird's lang → eigene Regel.
- **Nicht verrotten lassen** — Verhalten geändert? Regel-Satz re-posten. Code-Ref in `source` tot? Fixen.

---

*Pflege-Hinweis: Dieses Playbook lebt in `docs/AGENT-RULES-PLAYBOOK.md` (agent-master). Es ist im Onboarding-Briefing verlinkt und im Regeln-Tab des Dashboards erreichbar.*
