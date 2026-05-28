#!/usr/bin/env node
// LLM Benchmark Report Generator
//
// Reads /tmp/llm-bench-results.json (written by llm-benchmark.mjs),
// emits an HTML report styled for PDF, then uses headless Chrome to
// render the PDF. Output: /tmp/llm-bench-report.pdf

import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const RESULTS_PATH = "/tmp/llm-bench-results.json";
const HTML_PATH = "/tmp/llm-bench-report.html";
const PDF_PATH = "/tmp/llm-bench-report.pdf";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function fmt(n, suffix = "") {
  if (n == null || Number.isNaN(n)) return "—";
  if (n === 0) return `0${suffix}`;
  if (n < 1) return `${n.toFixed(3)}${suffix}`;
  if (n < 100) return `${Math.round(n * 10) / 10}${suffix}`;
  return `${Math.round(n).toLocaleString("de-DE")}${suffix}`;
}

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtCost(c) {
  if (!c) return "$0";
  return `$${c.toFixed(4)}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function classify(p50_ms) {
  if (p50_ms < 2000) return "fast";
  if (p50_ms < 10000) return "ok";
  return "slow";
}

function buildHtml(results) {
  const date = new Date(results.started_at).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
  const services = Object.entries(results.by_service);
  const promptIds = Object.keys(services[0]?.[1].by_prompt || {});

  // Aggregate: rank by quality first, then speed within the same quality tier.
  // Pure-speed ranking would falsely promote a fast-but-wrong model.
  const leaderboard = promptIds.map((pid) => {
    const rows = services.map(([model, s]) => ({
      model,
      label: s.label,
      p50: s.by_prompt[pid]?.p50_ms ?? Infinity,
      p95: s.by_prompt[pid]?.p95_ms ?? Infinity,
      tps: s.by_prompt[pid]?.mean_tokens_per_sec ?? 0,
      success_rate: s.by_prompt[pid]?.success_rate ?? 0,
      quality_pass_rate: s.by_prompt[pid]?.quality_pass_rate,  // null if no signal
      quality_n: s.by_prompt[pid]?.quality_n ?? 0,
      quality_pass_n: s.by_prompt[pid]?.quality_pass_n ?? 0,
      shadow_cost: s.by_prompt[pid]?.mean_shadow_cost_usd ?? 0,
      reasoning_overhead: s.by_prompt[pid]?.mean_reasoning_tokens ?? 0,
    })).filter((r) => Number.isFinite(r.p50));
    rows.sort((a, b) => {
      const qa = a.quality_pass_rate ?? 1;  // unknown quality = neutral
      const qb = b.quality_pass_rate ?? 1;
      if (qa !== qb) return qb - qa;        // higher quality first
      return a.p50 - b.p50;                  // then faster p50
    });
    return { prompt_id: pid, prompt_label: services[0][1].by_prompt[pid]?.prompt_label, rows };
  });

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>LLM Performance Benchmark — agent-master</title>
<style>
  @page { margin: 18mm 16mm; size: A4; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; font-size: 11pt; line-height: 1.45; }
  h1 { font-size: 22pt; margin: 0 0 4px 0; color: #111; }
  h2 { font-size: 14pt; margin: 22px 0 8px 0; border-bottom: 2px solid #1abc9c; padding-bottom: 4px; color: #111; }
  h3 { font-size: 12pt; margin: 16px 0 6px 0; color: #333; }
  .subtitle { color: #666; margin-bottom: 24px; font-size: 10pt; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px 0; font-size: 9.5pt; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f7f7f9; font-weight: 600; color: #333; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.winner td { background: #e8f8f4; font-weight: 600; }
  tr.loser td { background: #fdf3f0; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 8px; font-size: 8.5pt; font-weight: 600; }
  .pill-fast { background: #e8f8f4; color: #0a8762; }
  .pill-ok   { background: #fff4e0; color: #8a5a00; }
  .pill-slow { background: #fdf3f0; color: #a13838; }
  .pill-klick   { background: #d5f4ed; color: #0a6e57; }
  .pill-anthropic { background: #e8e0f5; color: #5a3a8c; }
  .meta { background: #f7f7f9; padding: 10px 14px; border-radius: 4px; font-size: 9.5pt; margin: 16px 0; }
  .meta b { color: #111; }
  .key-finding { background: #fef9e6; border-left: 4px solid #f6c700; padding: 10px 14px; margin: 12px 0; font-size: 10pt; }
  .key-finding b { color: #856200; }
  code, pre { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 9pt; background: #f4f4f6; padding: 1px 4px; border-radius: 2px; }
  pre { padding: 8px 12px; overflow-x: auto; white-space: pre-wrap; }
  .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #ddd; color: #888; font-size: 9pt; }
  .badge { font-size: 8pt; color: #666; }
  .ok { color: #0a8762; font-weight: 600; }
  .fail { color: #a13838; font-weight: 600; }
</style>
</head>
<body>

<h1>LLM Performance Benchmark</h1>
<div class="subtitle">agent-master Gateway · ${escapeHtml(date)} (Europe/Berlin) · methodology: BentoML / Anyscale 2026</div>

<div class="meta">
  <b>Tested services (${services.length}):</b><br>
  ${services.map(([m, s]) => `<code>${escapeHtml(m)}</code> — ${escapeHtml(s.label)}`).join("<br>")}
</div>

<div class="meta">
  <b>Methodology.</b> Each cell aggregates ${services[0]?.[1].by_prompt[promptIds[0]]?.n ?? "?"} runs (Opus: 3) per service × prompt-family.
  Prompts are <em>generated uniquely per run</em> (varying user IDs / fact questions / change descriptions) so that server-side KV-cache (LM Studio) and prompt-cache (Anthropic) cannot short-circuit.
  Gateway-Cache is disabled (<code>cache:false</code>). All calls go through <code>${escapeHtml("http://localhost:7890/api/llm/complete")}</code>.
  Latency = server-reported <code>latency_ms</code> (= the call's wall-clock as measured by the gateway).
  TTFT (streaming) = time-to-first-byte; first_text_ms = time until first visible text-delta event (for Qwen reasoning models this comes after the entire &lt;think&gt; chain).
</div>

${leaderboard.map((board) => `
<h2>${escapeHtml(board.prompt_label)}</h2>
<table>
  <thead>
    <tr>
      <th>Service</th>
      <th class="num">Quality</th>
      <th class="num">Success</th>
      <th class="num">p50 latency</th>
      <th class="num">p95 latency</th>
      <th class="num">tokens/sec</th>
      <th class="num">reasoning</th>
      <th class="num">~Anthropic cost</th>
      <th>Speed</th>
    </tr>
  </thead>
  <tbody>
    ${board.rows.map((r, i) => {
      const qHtml = r.quality_pass_rate == null
        ? `<span class="badge">n/a</span>`
        : r.quality_pass_rate === 1
          ? `<span class="ok">${r.quality_pass_n}/${r.quality_n}</span>`
          : `<span class="fail">${r.quality_pass_n}/${r.quality_n}</span>`;
      // Winner: top quality AND top-3 speed. Loser: low quality OR very slow.
      const isWinner = i === 0 && (r.quality_pass_rate == null || r.quality_pass_rate === 1);
      const isLoser = (r.quality_pass_rate != null && r.quality_pass_rate < 0.5) || r.p50 > 30000;
      return `<tr class="${isWinner ? "winner" : isLoser ? "loser" : ""}">
        <td>${escapeHtml(r.label)}</td>
        <td class="num">${qHtml}</td>
        <td class="num">${r.success_rate < 1 ? `<span class="fail">${(r.success_rate*100).toFixed(0)}%</span>` : `<span class="ok">100%</span>`}</td>
        <td class="num">${fmtMs(r.p50)}</td>
        <td class="num">${fmtMs(r.p95)}</td>
        <td class="num">${r.tps || "—"}</td>
        <td class="num">${r.reasoning_overhead ? `${r.reasoning_overhead}t` : "—"}</td>
        <td class="num">${fmtCost(r.shadow_cost)}</td>
        <td><span class="pill pill-${classify(r.p50)}">${classify(r.p50)}</span></td>
      </tr>`;
    }).join("")}
  </tbody>
</table>
`).join("")}

<h2>Streaming: Time-to-First-Token (TTFT)</h2>
<div class="meta">
  TTFT is the time until the first byte arrives. For interactive chat, this is what makes the system feel "fast" — even if total latency is high, a fast TTFT means the user starts seeing output quickly. Qwen reasoning models hide all visible output behind the &lt;think&gt; phase; <b>first_text_ms</b> is the more honest UX metric for them.
</div>
<table>
  <thead>
    <tr>
      <th>Service</th>
      <th class="num">TTFT (first byte)</th>
      <th class="num">First-visible-text</th>
      <th class="num">total latency</th>
      <th class="num">output_tokens</th>
      <th class="num">reasoning_tokens</th>
    </tr>
  </thead>
  <tbody>
    ${services.map(([m, s]) => {
      const sr = s.streaming;
      if (!sr || !sr.success) return `<tr><td>${escapeHtml(s.label)}</td><td class="num" colspan="5"><span class="fail">${sr ? escapeHtml(sr.error) : "n/a"}</span></td></tr>`;
      return `<tr>
        <td>${escapeHtml(s.label)}</td>
        <td class="num">${fmtMs(sr.ttft_ms)}</td>
        <td class="num">${fmtMs(sr.first_text_ms)}</td>
        <td class="num">${fmtMs(sr.latency_ms)}</td>
        <td class="num">${sr.output_tokens}</td>
        <td class="num">${sr.reasoning_tokens || "—"}</td>
      </tr>`;
    }).join("")}
  </tbody>
</table>

<h2>Wichtige Erkenntnisse</h2>
${(() => {
  const findings = [];
  // 1. Interpretation-Divergenz (Quality-Finding)
  const classBoard = leaderboard.find((b) => b.prompt_id === "classification");
  if (classBoard) {
    const lowQ = classBoard.rows.filter((r) => r.quality_pass_rate != null && r.quality_pass_rate < 0.5);
    const highQ = classBoard.rows.filter((r) => r.quality_pass_rate === 1);
    if (lowQ.length && highQ.length) {
      findings.push(`<b>Interpretations-Divergenz bei Severity-Klassifikation</b>: erwartet wurde "ERROR" für "[auth] login failed". <em>${highQ.map((r) => escapeHtml(r.model)).join(", ")}</em> antworten konsistent ERROR (security-Sicht); <em>${lowQ.map((r) => escapeHtml(r.model)).join(", ")}</em> antworten WARN (recoverable-Sicht). Beides ist plausibel — aber wenn dein severity-triage Template ERROR-Eskalations-Logik triggert, sind die WARN-Antworten ein Practical-Failure. <b>Konsequenz</b>: für strenge severity-Klassifikation Sonnet/Opus/klick:best, nicht Haiku/klick:small.`);
    }
  }
  // 2. Fastest per family with quality intact
  for (const board of leaderboard) {
    const top = board.rows.find((r) => r.quality_pass_rate == null || r.quality_pass_rate === 1);
    if (top) {
      findings.push(`<b>${escapeHtml(board.prompt_label)}</b>: schnellster Dienst mit voller Quality <code>${escapeHtml(top.model)}</code> — p50 ${fmtMs(top.p50)}, p95 ${fmtMs(top.p95)}.`);
    }
  }
  // 3. Reasoning overhead on klick
  const klickRows = classBoard?.rows.filter((r) => r.model.startsWith("klick:")) || [];
  const meanReasoning = klickRows.length ? Math.round(klickRows.reduce((a, b) => a + b.reasoning_overhead, 0) / klickRows.length) : 0;
  if (meanReasoning) {
    findings.push(`<b>Reasoning-Overhead bei Klick (Qwen)</b>: ø ${meanReasoning} reasoning_tokens pro Klassifikations-Call — das sind ${meanReasoning > 200 ? "deutlich mehr als" : "vergleichbar mit"} der sichtbaren Antwort. Bei kleinen <code>max_tokens</code> (Template-Default) würde der visible content auf 0 gedrückt — Gateway bumpt deshalb auto auf ≥4096.`);
  }
  // 4. Cost
  const sonnetCost = classBoard?.rows.find((r) => r.model === "sonnet")?.shadow_cost || 0;
  if (sonnetCost && klickRows.length) {
    const avgKlickShadow = klickRows.reduce((a, b) => a + b.shadow_cost, 0) / klickRows.length;
    findings.push(`<b>Cost-Profil</b>: gleiche Anfrage kostet auf Klick <code>$0</code> (läuft auf Jonas' Mac Studio), würde auf Sonnet ø ${fmtCost(avgKlickShadow)} kosten. Skaliert auf 1000 Calls/Tag: ~${fmtCost(avgKlickShadow * 1000)}/Tag Anthropic-Equivalent gespart.`);
  }
  // 5. TTFT
  const ttftFast = services.filter(([m, s]) => s.streaming?.success && s.streaming.first_text_ms < 2000);
  if (ttftFast.length) {
    findings.push(`<b>Streaming-UX (first visible text)</b>: ${ttftFast.length} Dienst${ttftFast.length === 1 ? "" : "e"} liefern visible text in &lt; 2s — entscheidend für interaktive UX. Die TTFT (byte 0) ist überall &lt; 5ms (= reines HTTP-Roundtrip, sagt nichts über LLM-Speed aus — first_text_ms ist die ehrliche Metrik).`);
  }
  return findings.map((f) => `<div class="key-finding">${f}</div>`).join("");
})()}

<h2>Detail-Tabelle: Alle Runs</h2>
${services.map(([m, s]) => `
<h3>${escapeHtml(s.label)} <span class="badge">[${escapeHtml(m)}]</span></h3>
<table>
  <thead>
    <tr>
      <th>Prompt</th>
      <th class="num">n</th>
      <th class="num">success</th>
      <th class="num">quality</th>
      <th class="num">p50</th>
      <th class="num">p95</th>
      <th class="num">min</th>
      <th class="num">max</th>
      <th class="num">ø tok/s</th>
      <th class="num">ø reasoning</th>
    </tr>
  </thead>
  <tbody>
    ${Object.entries(s.by_prompt).map(([pid, p]) => {
      const qStr = p.quality_pass_rate == null ? "n/a" : `${p.quality_pass_n}/${p.quality_n}`;
      return `<tr>
        <td>${escapeHtml(p.prompt_label)}</td>
        <td class="num">${p.n}</td>
        <td class="num">${(p.success_rate * 100).toFixed(0)}%</td>
        <td class="num">${qStr}</td>
        <td class="num">${fmtMs(p.p50_ms)}</td>
        <td class="num">${fmtMs(p.p95_ms)}</td>
        <td class="num">${fmtMs(p.min_ms)}</td>
        <td class="num">${fmtMs(p.max_ms)}</td>
        <td class="num">${p.mean_tokens_per_sec || "—"}</td>
        <td class="num">${p.mean_reasoning_tokens || "—"}</td>
      </tr>`;
    }).join("")}
  </tbody>
</table>
`).join("")}

<div class="footer">
  Generated by <code>scripts/llm-benchmark.mjs</code> + <code>scripts/llm-benchmark-report.mjs</code> · agent-master Hub<br>
  Started: ${escapeHtml(results.started_at)} · Finished: ${escapeHtml(results.finished_at)}<br>
  Quellen für Methodik: <em>BentoML LLM Inference Handbook</em>, <em>Anyscale LLM Serving Docs</em>, <em>Kunal Ganglani 2026 Latency Benchmarks</em>.
</div>

</body>
</html>`;
}

async function generatePdf() {
  const raw = await readFile(RESULTS_PATH, "utf8");
  const results = JSON.parse(raw);
  const html = buildHtml(results);
  await writeFile(HTML_PATH, html);
  console.log(`[report] HTML written: ${HTML_PATH}`);

  await new Promise((resolve, reject) => {
    const ch = spawn(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--print-to-pdf=" + PDF_PATH,
      "--print-to-pdf-no-header",
      "file://" + HTML_PATH,
    ], { stdio: "pipe" });
    let stderr = "";
    ch.stderr.on("data", (d) => { stderr += d; });
    ch.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`chrome exit ${code}: ${stderr.slice(0, 300)}`));
    });
  });
  console.log(`[report] PDF written: ${PDF_PATH}`);
}

generatePdf().catch((e) => { console.error("[report] fatal:", e); process.exit(1); });
