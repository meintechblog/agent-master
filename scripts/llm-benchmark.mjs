#!/usr/bin/env node
// LLM Service Performance Benchmark
//
// Runs a fixed prompt suite across every available backend via the
// gateway at http://localhost:7890. Records end-to-end latency,
// TTFT (via streaming), token-throughput, success rate.
//
// Methodology pulled from 2026 LLM-benchmarking best-practice (BentoML,
// Anyscale, Kunal Ganglani):
//   - multiple runs (3–5) per prompt × service for p50/p95 stability
//   - mix prompt sizes: tiny / short / medium to surface scaling effects
//   - measure TTFT separately from end-to-end (chat UX cares about TTFT)
//   - cold + warm samples flagged
//   - report success rate even if latency is good
//
// Caps:
//   - opus: only ONE call (cheapest prompt) to protect the 7-day cap
//   - klick:* is free, so we run those broader
//
// Output: /tmp/llm-bench-results.json — consumed by the report script.

import { writeFile } from "node:fs/promises";

const GATEWAY = "http://localhost:7890";

// Prompt families. The exact prompt is generated per-run with a unique
// suffix so LM Studio's KV-cache and Anthropic's prompt-cache can't
// short-circuit a re-run (we saw <100ms responses on repeat calls — that's
// cache, not inference, and skews the comparison).
//
// `expected` is a substring we look for in the output for a basic
// quality signal (NOT a semantic eval — just "did the model get the gist?").
const PROMPT_FAMILIES = [
  {
    id: "classification",
    label: "Tiny classification (severity triage)",
    builder: (n) => `Classify the severity of this log line as exactly one word — ERROR, WARN, or INFO: "[auth-${n}] login failed for user=admin from ip=10.0.0.${n % 250 + 1}"`,
    expected_substrings: ["ERROR"],
    expected_short: true,
    max_tokens: 4096,
  },
  {
    id: "factual",
    label: "Short factual recall",
    builder: (n) => {
      const facts = [
        ["Capital of France?", "Paris"],
        ["Largest planet in our solar system?", "Jupiter"],
        ["Year Berlin Wall fell?", "1989"],
        ["Author of '1984'?", "Orwell"],
        ["Chemical symbol for gold?", "Au"],
      ];
      const [q, a] = facts[n % facts.length];
      return { prompt: `${q} Reply with just the answer, no punctuation.`, expected: a };
    },
    expected_short: true,
    max_tokens: 4096,
  },
  {
    id: "generation",
    label: "Medium generation (commit message)",
    builder: (n) => {
      const changes = [
        "added retry logic with exponential backoff to the API client",
        "fixed null pointer in user authentication flow",
        "renamed the payment processor module for clarity",
        "removed deprecated lookup table from the cache layer",
        "added structured logging to the database connection pool",
      ];
      const change = changes[n % changes.length];
      return `Write a one-line conventional commit message (≤72 chars, no body) for this change: ${change}`;
    },
    expected_substrings: [],  // no easy keyword check
    expected_short: false,
    max_tokens: 4096,
  },
];

// Services to benchmark. klick is free → broader runs; Anthropic is cheap
// per-call but we still keep it sensible. Per Jörg: opus is fully in
// (cap is not a concern), quality > speed.
const SERVICES = [
  { model: "klick:best",  label: "Klick · best (Qwen3.6-35B-MoE)",  runs_per_prompt: 5 },
  { model: "klick:fast",  label: "Klick · fast (= best in current config)", runs_per_prompt: 5 },
  { model: "klick:small", label: "Klick · small (Qwen3.6-27B dense)", runs_per_prompt: 5 },
  { model: "sonnet",      label: "Anthropic · Sonnet 4.6",          runs_per_prompt: 5 },
  { model: "haiku",       label: "Anthropic · Haiku 4.5",           runs_per_prompt: 5 },
  { model: "opus",        label: "Anthropic · Opus 4.7",            runs_per_prompt: 3 },
];

function generatePrompt(family, n) {
  const out = family.builder(n);
  if (typeof out === "string") {
    return { prompt: out, expected_substrings: family.expected_substrings || [] };
  }
  return {
    prompt: out.prompt,
    expected_substrings: out.expected ? [out.expected] : (family.expected_substrings || []),
  };
}

function qualityCheck(text, expectedSubstrings) {
  if (!expectedSubstrings.length) return { has_signal: false };
  const found = expectedSubstrings.filter((s) =>
    text.toLowerCase().includes(s.toLowerCase())
  );
  return {
    has_signal: true,
    matched: found.length,
    expected: expectedSubstrings.length,
    quality_pass: found.length === expectedSubstrings.length,
  };
}

function p(arr, pct) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[idx];
}

function summarize(samples) {
  const ok = samples.filter((s) => s.success);
  const lats = ok.map((s) => s.latency_ms);
  // Quality is a separate dimension from success: HTTP-200 with the wrong
  // answer is a quality failure but a success in availability terms. We
  // only count quality among runs that actually had an expected substring.
  const withQ = ok.filter((s) => s.quality && s.quality.has_signal);
  const qPass = withQ.filter((s) => s.quality.quality_pass);
  return {
    n: samples.length,
    n_ok: ok.length,
    success_rate: samples.length ? ok.length / samples.length : 0,
    quality_n: withQ.length,
    quality_pass_n: qPass.length,
    quality_pass_rate: withQ.length ? qPass.length / withQ.length : null,
    p50_ms: p(lats, 50),
    p95_ms: p(lats, 95),
    min_ms: lats.length ? Math.min(...lats) : 0,
    max_ms: lats.length ? Math.max(...lats) : 0,
    mean_ms: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0,
    mean_output_tokens: ok.length ? Math.round(ok.reduce((a, b) => a + (b.output_tokens || 0), 0) / ok.length) : 0,
    mean_reasoning_tokens: ok.length ? Math.round(ok.reduce((a, b) => a + (b.reasoning_tokens || 0), 0) / ok.length) : 0,
    mean_tokens_per_sec: ok.length
      ? Math.round(ok.reduce((a, b) => a + ((b.output_tokens || 0) / (b.latency_ms / 1000)), 0) / ok.length)
      : 0,
    mean_shadow_cost_usd: ok.length
      ? Math.round(ok.reduce((a, b) => a + (b.shadow_cost_usd || 0), 0) / ok.length * 100000) / 100000
      : 0,
    fallback_count: samples.filter((s) => s.fallback_fired).length,
    samples,
  };
}

async function callNonStream({ model, prompt, max_tokens, caller, no_fallback }) {
  const t0 = Date.now();
  const body = { model, prompt, max_tokens, caller, cache: false };
  if (no_fallback) body.no_fallback = true;
  const r = await fetch(`${GATEWAY}/api/llm/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const wall_ms = Date.now() - t0;
  if (!r.ok) {
    const txt = await r.text();
    return { success: false, latency_ms: wall_ms, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
  }
  const j = await r.json();
  return {
    success: true,
    latency_ms: j.latency_ms || wall_ms,
    wall_clock_ms: wall_ms,
    text_len: (j.text || "").length,
    text_preview: (j.text || "").trim().slice(0, 80),
    input_tokens: j.usage?.input_tokens || 0,
    output_tokens: j.usage?.output_tokens || 0,
    reasoning_tokens: j.usage?.reasoning_tokens || 0,
    total_tokens: j.usage?.total_tokens || 0,
    raw_cost_usd: j.raw_cost_usd || 0,
    shadow_cost_usd: j.shadow_cost?.estimated_usd || 0,
    fallback_fired: !!j.fallback,
    provider: j.provider,
    logical_model: j.logical_model,
  };
}

async function callStream({ model, prompt, max_tokens, caller }) {
  const t0 = Date.now();
  let ttft_ms = null;
  let first_text_ms = null;
  const body = { model, prompt, max_tokens, caller, cache: false, no_fallback: true };
  let lastEvent = null;
  let buffered = "";
  let final = null;
  let firstByteSeen = false;
  let firstTextSeen = false;
  try {
    const r = await fetch(`${GATEWAY}/api/llm/complete/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      return { success: false, latency_ms: Date.now() - t0, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstByteSeen) {
        ttft_ms = Date.now() - t0;
        firstByteSeen = true;
      }
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith("event:")) {
          lastEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          try {
            const j = JSON.parse(payload);
            if (lastEvent === "text" && !firstTextSeen) {
              first_text_ms = Date.now() - t0;
              firstTextSeen = true;
            }
            if (lastEvent === "text") buffered += j.text || "";
            if (lastEvent === "done") final = j;
          } catch {}
        }
      }
    }
  } catch (e) {
    return { success: false, latency_ms: Date.now() - t0, error: e.message };
  }
  if (!final) return { success: false, latency_ms: Date.now() - t0, error: "no done event" };
  return {
    success: true,
    latency_ms: final.latency_ms || (Date.now() - t0),
    wall_clock_ms: Date.now() - t0,
    ttft_ms,
    first_text_ms,
    text_len: buffered.length,
    text_preview: buffered.trim().slice(0, 80),
    input_tokens: final.usage?.input_tokens || 0,
    output_tokens: final.usage?.output_tokens || 0,
    reasoning_tokens: final.usage?.reasoning_tokens || 0,
    total_tokens: final.usage?.total_tokens || 0,
    raw_cost_usd: final.raw_cost_usd || 0,
    shadow_cost_usd: final.shadow_cost?.estimated_usd || 0,
    provider: final.provider,
    logical_model: final.logical_model,
  };
}

async function runBenchmark() {
  const startedAt = new Date().toISOString();
  console.log(`[bench] start ${startedAt}`);
  const results = {
    started_at: startedAt,
    methodology: {
      source: "BentoML / Anyscale / 2026 LLM benchmarking best-practice",
      runs_per_prompt_default: "5 (3 for Opus)",
      prompt_families: PROMPT_FAMILIES.map((f) => ({ id: f.id, label: f.label, expected_short: f.expected_short })),
      services: SERVICES.map((s) => s.model),
      note: "Each run uses a unique generated prompt (varying user IDs / fact questions / change descriptions) to defeat server-side KV-cache and prompt-cache. Hub cache:false + no_fallback:true. Stream run measures TTFT (time-to-first-byte) and first_text_ms (time-to-first-visible-text-event; for Qwen reasoning models this is post-thinking-chain).",
    },
    by_service: {},
    finished_at: null,
  };

  let runCounter = 0;  // global counter so every prompt is unique across services

  for (const svc of SERVICES) {
    console.log(`\n[bench] service: ${svc.model}`);
    results.by_service[svc.model] = {
      label: svc.label,
      by_prompt: {},
      streaming: null,
    };
    for (const family of PROMPT_FAMILIES) {
      const samples = [];
      for (let i = 1; i <= svc.runs_per_prompt; i++) {
        runCounter += 1;
        const generated = generatePrompt(family, runCounter);
        process.stdout.write(`  ${family.id} run ${i}/${svc.runs_per_prompt}…`);
        const r = await callNonStream({
          model: svc.model,
          prompt: generated.prompt,
          max_tokens: family.max_tokens,
          caller: "hub-bench",
          no_fallback: true,
        });
        const q = r.success ? qualityCheck(r.text_preview || "", generated.expected_substrings) : { has_signal: false };
        process.stdout.write(` ${r.success ? "✓" : "✗"} ${r.latency_ms}ms${q.has_signal ? (q.quality_pass ? " Q✓" : " Q✗") : ""}\n`);
        samples.push({ run: i, cold: i === 1, prompt_used: generated.prompt, ...r, quality: q });
      }
      results.by_service[svc.model].by_prompt[family.id] = {
        prompt_label: family.label,
        ...summarize(samples),
      };
    }
    // Streaming probe — also with a unique prompt to defeat caches.
    runCounter += 1;
    process.stdout.write(`  stream TTFT…`);
    const sr = await callStream({
      model: svc.model,
      prompt: `Reply with exactly this word and nothing else: token_${runCounter}`,
      max_tokens: 4096,
      caller: "hub-bench-stream",
    });
    process.stdout.write(` ${sr.success ? "✓" : "✗"} ttft=${sr.ttft_ms}ms first_text=${sr.first_text_ms}ms\n`);
    results.by_service[svc.model].streaming = sr;
  }

  results.finished_at = new Date().toISOString();
  await writeFile("/tmp/llm-bench-results.json", JSON.stringify(results, null, 2));
  console.log(`\n[bench] done. wrote /tmp/llm-bench-results.json`);
  return results;
}

runBenchmark().catch((e) => { console.error("[bench] fatal:", e); process.exit(1); });
