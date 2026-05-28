You are Claude Code acting as implementation worker. Hulki remains coordinator/reviewer.

Task: Redesign the existing David Sinclair supplement page into a radically simpler, usable single-page web app for Jörg.

Target file to edit:
/Users/hulki/.openclaw/workspace/notes/summarize-projects/david-sinclair-stack/site/index.html

Related audit artifact (do not break this, update if needed):
/Users/hulki/.openclaw/workspace/notes/summarize-projects/david-sinclair-stack/site/link-audit.tsv

User complaint/goal (important):
The current page has too many sections and feels like a dossier. He needs a practical app that answers: what do I take when, how much, where/how, and what is behind it. Morning / midday / evening is fine, or morning/evening only if more honest. It must be simple and beautiful.

Design direction:
- Make the top of the app the main usable product, not a research dossier.
- Primary view: “Tagesübersicht” or “Einnahme-Kompass” (not “Medikamentenplan”).
- Show grouped cards: Morgens, Mit Mahlzeit / Mittags, Abends / Rx & Intervall.
- Each item should show: substance, dose (or “im Clip nicht genannt”), when/how to take, why, confidence/source badge (Video vs Kontext), link to product/search + link to details/source.
- Keep medical safety by wording as source-grounded research summary, not personal prescription.
- Do not bury the useful plan behind many sections.
- Collapse or simplify old sections. Details can be in compact accordion-like cards or a “Details & Quellen” lower area.
- Keep Germany-first links and existing source separation. Do NOT add unverified/broken links.
- Preserve all currently verified external links unless restructuring; if removing/adding, run/update checks.
- Avoid massive walls of text. Make it phone-friendly.
- No affiliate vibe, no fake certainty.

Content rules:
- Video-confirmed core: NMN, Resveratrol, Berberine/Metformin context, Nattokinase, Niacin, Statin.
- Concrete video doses: NMN 1g daily, Resveratrol ~1g with fat/yogurt/olive oil, Niacin 0.5g currently.
- Doses unknown in clip: Berberine, Nattokinase, exact Statin dose/brand.
- Rx/context items must be visibly marked: Metformin, Statin, Rapamycin/Sirolimus, Aspirin/ASS.
- Context-only items must be visibly marked: D3/K2, CoQ10, Fisetin, Spermidine, Alpha-lipoic acid, Omega-3, TMG/Taurine/Quercetin.

Implementation constraints:
- Single static HTML file; no build step.
- Keep it polished: visual hierarchy, cards, table only if genuinely useful.
- Add small JS only if needed for filtering/tabs/details toggles.
- Ensure all internal anchors work after render.
- Do not delete sources/data unless redundant; prefer moving to collapsible details.

Verification to run before finishing:
1) HTML parse check.
2) JS/render sanity using Node or browser if possible.
3) Extract external URLs from final HTML and verify no HTTP errors with a real browser-ish User-Agent.
4) Ensure no docmorris.de, fairvital.com, sunday.de URLs are present.
5) Local server check at http://127.0.0.1:8765/index.html if server is running; otherwise note not checked.
6) git diff summary.

Do not commit. Hulki will review and commit.

Notification route for completion:
- channel: telegram
- target: telegram:297934858
- account: default
- reply_to: 8208

When the task is completely finished, send exactly one concise completion message back to the user with openclaw message send using that route, saying the simplified app draft is ready for Hulki review. If the task fails fatally, send exactly one failure message back to the user with openclaw message send using that route.
Do not use openclaw system event. Do not rely on heartbeat. Do not skip the completion/failure message.
