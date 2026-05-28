# WA-Bridge Routing for the Hub-Session

This file is part of the netzbetreiber-master repo only because the Hub-Session
runs out of `~/codex/allgemein`. It does **not** describe netzbetreiber-master
itself — it describes how *this* terminal acts as the WhatsApp Hub.

## Inbound recognition

If a channel-push from `wa-bridge` arrives in this session, the body starts
with this header:

```
📱 [wa-in from=+PHONE-REDACTED ts=<iso> msg_id=<wa-id>]
<message body>
```

`from_id` in the `<channel>` tag will be the `wa-bridge` peer-id, and
`from_summary` will say `wa-bridge: WhatsApp ↔ allgemein-Hub. …`.

## Decision tree

When such a message arrives:

1. **Direct answer possible?**
   E.g. a simple question, status request, general chat → answer directly via
   the outbox (see below). Keep it short — WhatsApp is a phone screen.

2. **Belongs to another repo?**
   E.g. "Hat wallbox-master Phase 12 deployed?", "Update vom energy-master?",
   "ecoflow-master kaputt?".
   → `list_peers(scope=machine)`, find the matching repo peer, send them a
   `send_message` with the relevant slice of Hulki's question. Wait for their
   reply. Then condense and forward to Hulki via outbox.
   - Tell Hulki immediately *"Frage an X geleitet, melde mich wenn er antwortet."*
   - Persist progress pings every ~30s for long tasks.

3. **Multiple repos involved?**
   Fan out, collect, summarize.

## Outbox: how to send back to Hulki

Drop a JSON file into `~/codex/wa-bridge/data/outbox/<uuid>.json`.

Schema:

```json
{
  "id":          "<uuid>",
  "sender_repo": "allgemein",
  "msg_type":    "wa_reply",
  "to_e164":     "+PHONE-REDACTED",
  "body":        "<text reply>",
  "dedupe_key":  null,
  "created_at":  "<ISO-8601>"
}
```

Write via temp + rename (atomic). The bridge polls the dir every ~1s.

CLI helper if you're in a shell:

```
node ~/codex/wa-bridge/tools/wa-reply.mjs "Status: alles grün."
```

`msg_type` options:
- `wa_reply` — normal reply to an incoming message
- `wa_status_ping` — mid-task progress update
- `wa_alert` — urgent (deploy fail, capacity, etc.)

## Style for WhatsApp replies

- Short. Hulki reads on a phone.
- One paragraph for status; bullet list only if 3+ items.
- No code blocks unless necessary.
- Skip pleasantries.

## What NOT to do

- Don't `npm start` the bridge from this session — it lives in its own launchd job.
- Don't write directly into `~/.openclaw/credentials/whatsapp/` — that's
  openclaw's territory. Bridge has its own auth at `~/codex/wa-bridge/data/auth/`.
- Don't run openclaw and the bridge simultaneously (single linked-device slot).

## Debugging

- Bridge logs: `~/codex/wa-bridge/data/logs/bridge.stdout.log`
- Pairing required? Bridge writes `~/codex/wa-bridge/data/pairing-code.json`
  with a current code; file is removed on successful connect.
- Outbox state: `*.json` = pending, `*.sending` = in flight, `*.sent` = done,
  `*.failed` = check `bridge.reason` field.
