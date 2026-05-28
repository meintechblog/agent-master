// External LLM backends (OpenAI-API-compatible proxies).
//
// Why: we already had anthropic-cli, anthropic-api, and ollama providers.
// Jonas put us on `https://llm.your-klick.de` (LM Studio reverse-proxy with
// Qwen3.6-35B-A3B MLX behind 4 alias keys: best, fast, long-context, small).
// Rather than hard-coding "klick", this module supports any registered
// OpenAI-compatible backend listed in data/external-llm.json.
//
// Backend config shape (data/external-llm.json):
//   {
//     "backends": {
//       "klick": {
//         "base_url": "https://llm.your-klick.de",
//         "api_key": "sk-...",          // or "api_key_env": "KLICK_API_KEY"
//         "models": ["best","fast","small","long-context"],
//         "default_model": "best",
//         "default_max_tokens": 4096,   // higher than anthropic because reasoning eats budget
//         "supports_reasoning": true,   // surface reasoning_content as thinking
//         "note": "free-form"
//       }
//     }
//   }
//
// Caller routes via `model: "klick:best"` (pattern: <backend>:<model_id>).
// The bare backend name (no `:<model>`) resolves to its default_model.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data", "external-llm.json");

let cachedConfig = null;
let cachedAt = 0;
const CONFIG_TTL_MS = 60_000;

export async function loadExternalConfig() {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CONFIG_TTL_MS) return cachedConfig;
  if (!existsSync(CONFIG_PATH)) {
    cachedConfig = { backends: {} };
    cachedAt = now;
    return cachedConfig;
  }
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cachedConfig = parsed && typeof parsed === "object" && parsed.backends ? parsed : { backends: {} };
  } catch {
    cachedConfig = { backends: {} };
  }
  cachedAt = now;
  return cachedConfig;
}

/**
 * Parse a model string like "klick:best" → { backendName: "klick", modelId: "best" }.
 * Bare "klick" → default model. Returns null if not an external pattern.
 *
 * Reserved prefixes that are NOT external backends:
 *   - "local:" → ollama (handled elsewhere)
 *   - "claude-…" → bare model IDs, not backend-prefixed
 */
const RESERVED_PREFIXES = new Set(["local"]);

export function parseExternalModel(modelStr, config) {
  if (typeof modelStr !== "string" || !modelStr) return null;
  const colonIdx = modelStr.indexOf(":");
  let backendName, modelId;
  if (colonIdx < 0) {
    backendName = modelStr;
    modelId = null;
  } else {
    backendName = modelStr.slice(0, colonIdx);
    modelId = modelStr.slice(colonIdx + 1);
  }
  if (RESERVED_PREFIXES.has(backendName)) return null;
  const backend = config?.backends?.[backendName];
  if (!backend) return null;
  if (!modelId) modelId = backend.default_model || backend.models?.[0];
  if (!modelId) throw new Error(`external backend "${backendName}" has no default_model and no models[] entry`);
  return { backendName, modelId, backend };
}

/**
 * Resolve a backend's API key (inline or via env var indirection).
 */
function resolveApiKey(backend) {
  if (backend.api_key) return backend.api_key;
  if (backend.api_key_env) {
    const v = process.env[backend.api_key_env];
    if (!v) throw new Error(`backend api_key_env "${backend.api_key_env}" is not set in process env`);
    return v;
  }
  throw new Error("backend has neither api_key nor api_key_env");
}

/**
 * Non-streaming OpenAI-compatible chat completion.
 * Returns the canonical gateway result shape (matches callAnthropicCli).
 */
export async function callOpenAICompat({ backendName, backend, modelId, prompt, system, maxTokens, timeoutMs = 60_000 }) {
  const apiKey = resolveApiKey(backend);
  const url = `${backend.base_url.replace(/\/$/, "")}/v1/chat/completions`;
  // Reasoning models burn a lot of tokens on internal thinking. If caller
  // didn't specify, pick the backend default (4096+) so visible content
  // isn't choked off by reasoning_tokens.
  const effectiveMax = maxTokens || backend.default_max_tokens || 4096;
  const body = {
    model: modelId,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
    max_tokens: effectiveMax,
    stream: false,
  };

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`${backendName} timeout after ${timeoutMs}ms`);
    throw new Error(`${backendName} unreachable: ${e.message}`);
  }
  clearTimeout(timer);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`${backendName} HTTP ${r.status}: ${txt.slice(0, 300)}`);
  }
  const json = await r.json();
  const latency_ms = Date.now() - t0;
  const choice = json.choices?.[0];
  const message = choice?.message || {};
  const text = message.content || "";
  // Reasoning models (Qwen, o1, deepseek-r1) put internal thinking in
  // reasoning_content. Surface separately so callers can ignore it or log it.
  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || null;
  const usage = json.usage || {};
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

  const warnings = [];
  if (!text && choice?.finish_reason === "length") {
    warnings.push(`empty content, finish_reason=length — reasoning_tokens=${reasoningTokens} ate the max_tokens budget. Raise max_tokens (current: ${effectiveMax}).`);
  }
  if (latency_ms > 15_000) {
    warnings.push(`latency ${latency_ms}ms exceeds 15s SLA`);
  }
  return {
    text,
    json: null,                     // OpenAI-mode doesn't return structured_output here
    thinking: reasoning,            // Qwen/o1-style internal reasoning, if any
    model: modelId,
    logical_model: `${backendName}:${modelId}`,
    provider: "openai-compatible",
    backend: backendName,
    latency_ms,
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      total_tokens: inputTokens + outputTokens,
    },
    raw_cost_usd: 0,                // external backend, cost lives elsewhere
    stop_reason: choice?.finish_reason || null,
    system_fingerprint: json.system_fingerprint || null,
    warnings: warnings.length ? warnings : undefined,
  };
}

/**
 * Streaming OpenAI-compatible chat completion. Emits onEvent({type, text}):
 *   - type: "text"     → visible answer delta
 *   - type: "thinking" → reasoning delta (if backend.supports_reasoning)
 *   - type: "done"     → final aggregate
 *   - type: "error"    → fatal
 *
 * Returns the final result object.
 */
export async function callOpenAICompatStream({ backendName, backend, modelId, prompt, system, maxTokens, timeoutMs = 60_000, includeThinking = false }, onEvent) {
  const apiKey = resolveApiKey(backend);
  const url = `${backend.base_url.replace(/\/$/, "")}/v1/chat/completions`;
  const effectiveMax = maxTokens || backend.default_max_tokens || 4096;

  const body = {
    model: modelId,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
    max_tokens: effectiveMax,
    stream: true,
    stream_options: { include_usage: true },  // many proxies honour this for final-chunk usage
  };

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`${backendName} timeout after ${timeoutMs}ms`);
    throw new Error(`${backendName} unreachable: ${e.message}`);
  }
  if (!r.ok) {
    clearTimeout(timer);
    const txt = await r.text();
    throw new Error(`${backendName} HTTP ${r.status}: ${txt.slice(0, 300)}`);
  }

  // Read SSE stream line-by-line.
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let textBuf = "";
  let thinkingBuf = "";
  let lastUsage = null;
  let lastFinish = null;
  let lastFingerprint = null;
  let modelEcho = modelId;
  // Some reasoning proxies (LM Studio for Qwen) emit <think>…</think> INLINE
  // in delta.content during streaming, even though non-stream responses split
  // it out into reasoning_content. State machine routes chars accordingly so
  // SSE consumers see clean "text" events plus optional "thinking" events.
  // Uses a small carry buffer so we don't split a tag across two chunks.
  let mode = "text";       // "text" or "thinking"
  let carry = "";          // unflushed prefix that might start a tag
  const THINK_OPEN = "<think>";
  const THINK_CLOSE = "</think>";
  const flushChunk = (chunk) => {
    let cursor = 0;
    while (cursor < chunk.length) {
      if (mode === "text") {
        const i = chunk.indexOf(THINK_OPEN, cursor);
        if (i < 0) {
          const tail = chunk.slice(cursor);
          // Hold a suffix that could be the start of a tag for the next chunk.
          const safe = tail.slice(0, Math.max(0, tail.length - (THINK_OPEN.length - 1)));
          const keep = tail.slice(safe.length);
          if (safe) { textBuf += safe; onEvent?.({ type: "text", text: safe }); }
          carry = keep;
          return;
        }
        const safe = chunk.slice(cursor, i);
        if (safe) { textBuf += safe; onEvent?.({ type: "text", text: safe }); }
        cursor = i + THINK_OPEN.length;
        mode = "thinking";
      } else {
        const i = chunk.indexOf(THINK_CLOSE, cursor);
        if (i < 0) {
          const tail = chunk.slice(cursor);
          const safe = tail.slice(0, Math.max(0, tail.length - (THINK_CLOSE.length - 1)));
          const keep = tail.slice(safe.length);
          if (safe) {
            thinkingBuf += safe;
            if (includeThinking || backend.supports_reasoning) onEvent?.({ type: "thinking", text: safe });
          }
          carry = keep;
          return;
        }
        const safe = chunk.slice(cursor, i);
        if (safe) {
          thinkingBuf += safe;
          if (includeThinking || backend.supports_reasoning) onEvent?.({ type: "thinking", text: safe });
        }
        cursor = i + THINK_CLOSE.length;
        mode = "text";
      }
    }
    carry = "";
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.system_fingerprint) lastFingerprint = chunk.system_fingerprint;
        if (chunk.model) modelEcho = chunk.model;
        if (chunk.usage) lastUsage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta || {};
        if (chunk.choices?.[0]?.finish_reason) lastFinish = chunk.choices[0].finish_reason;
        if (delta.content) {
          flushChunk(carry + delta.content);
        }
        // Some proxies emit delta.reasoning_content separately (real GPT-o1 style).
        if (delta.reasoning_content) {
          thinkingBuf += delta.reasoning_content;
          if (includeThinking || backend.supports_reasoning) {
            onEvent?.({ type: "thinking", text: delta.reasoning_content });
          }
        }
      }
    }
    // Flush any trailing carry that wasn't part of a tag.
    if (carry) {
      if (mode === "text") { textBuf += carry; onEvent?.({ type: "text", text: carry }); }
      else { thinkingBuf += carry; if (includeThinking || backend.supports_reasoning) onEvent?.({ type: "thinking", text: carry }); }
    }
  } finally {
    clearTimeout(timer);
  }

  const latency_ms = Date.now() - t0;
  const inputTokens = lastUsage?.prompt_tokens || 0;
  const outputTokens = lastUsage?.completion_tokens || 0;
  const reasoningTokens = lastUsage?.completion_tokens_details?.reasoning_tokens || 0;
  const warnings = [];
  if (!textBuf && lastFinish === "length") {
    warnings.push(`empty content, finish_reason=length — reasoning_tokens=${reasoningTokens} ate the max_tokens budget. Raise max_tokens (current: ${effectiveMax}).`);
  }
  if (latency_ms > 15_000) warnings.push(`latency ${latency_ms}ms exceeds 15s SLA`);

  const result = {
    text: textBuf,
    json: null,
    thinking: thinkingBuf || null,
    model: modelEcho,
    logical_model: `${backendName}:${modelId}`,
    provider: "openai-compatible",
    backend: backendName,
    latency_ms,
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      total_tokens: inputTokens + outputTokens,
    },
    raw_cost_usd: 0,
    stop_reason: lastFinish,
    system_fingerprint: lastFingerprint,
    warnings: warnings.length ? warnings : undefined,
  };
  onEvent?.({ type: "done", result });
  return result;
}

/**
 * Enumerate registered external backends + their models for /api/llm/models.
 */
export async function listExternalBackends() {
  const cfg = await loadExternalConfig();
  return Object.entries(cfg.backends).map(([name, b]) => ({
    name,
    base_url: b.base_url,
    models: b.models || (b.default_model ? [b.default_model] : []),
    default_model: b.default_model || null,
    default_max_tokens: b.default_max_tokens || 4096,
    supports_reasoning: !!b.supports_reasoning,
    note: b.note || null,
    has_api_key: !!(b.api_key || (b.api_key_env && process.env[b.api_key_env])),
  }));
}
