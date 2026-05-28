// LLM Gateway — model-agnostisches Backend für Peer-LLM-Calls.
//
// Why: Andere Agenten sollen Trivial-Tasks (Klassifikation, Extraktion,
// Zusammenfassung) an günstigere Modelle delegieren statt Opus zu burnen.
// Hub bietet `POST /api/llm/complete` an, intern routet eine Provider-Map
// auf den jeweils passenden Backend.
//
// Provider:
//   - anthropic-cli  : spawnt `claude --print --model X` und liest JSON-Output.
//                      Nutzt Jörgs Pro/Max-Plan-Limits (kein API-Key).
//                      Default für sonnet/haiku/opus.
//   - anthropic-api  : direkter HTTPS-Call gegen api.anthropic.com mit
//                      ANTHROPIC_API_KEY aus env. Optional, nur wenn der Key
//                      gesetzt ist. Schneller (kein CLI-Cold-Start), kostet
//                      aber separat (geht NICHT gegen das Pro-Plan).
//   - ollama         : Skelett für lokale LLMs (http://localhost:11434).
//                      Noch nicht implementiert.
//
// Modelle (Logical → CLI-ID):
//   sonnet → claude-sonnet-4-6
//   haiku  → claude-haiku-4-5
//   opus   → claude-opus-4-7

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { applyTemplate } from "./llm-templates.mjs";
import { cacheKey, getCached, setCached, DEFAULTS as CACHE_DEFAULTS } from "./llm-cache.mjs";

const MODEL_MAP = {
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5",
  opus:   "claude-opus-4-7",
};

const DEFAULT_MODEL = "sonnet";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

// Empty cwd for the CLI subprocess so no CLAUDE.md auto-loads. /tmp is safest
// — every Mac has it, no project-specific context bleeds in.
const SAFE_CWD = "/tmp";

// LaunchAgent runs with a minimal PATH (no ~/.local/bin), so resolve the
// absolute claude binary path once at module load. Env var override wins for
// non-standard installs.
const CLAUDE_BIN = process.env.CLAUDE_CLI_BIN
  || (existsSync(`${process.env.HOME}/.local/bin/claude`) ? `${process.env.HOME}/.local/bin/claude` : "claude");

/**
 * Run a single LLM completion via the claude CLI in --print mode.
 * Returns { text, usage, model, provider, latency_ms, raw_cost_usd }.
 */
async function callAnthropicCli({ logicalModel, prompt, system, maxTokens, jsonSchema, timeoutMs }) {
  const modelId = MODEL_MAP[logicalModel];
  if (!modelId) throw new Error(`unknown logical model: ${logicalModel}`);

  // Flags chosen to MINIMIZE tokens against Jörgs plan quota:
  // - --system-prompt overrides the default tool-heavy system
  // - --setting-sources '' ignores ~/.claude/settings.json (no agents/mcp/etc)
  // - --strict-mcp-config + empty config → no MCP servers loaded
  // - --disable-slash-commands → no skill discovery
  // - --allowedTools '' → no tool definitions in context
  // - --exclude-dynamic-system-prompt-sections → no env/git/cwd snapshots
  // KNOWN LIMIT (2026-05-28): The `claude` CLI in --print mode has NO
  // --max-tokens flag — only --max-turns. The model runs until natural
  // stop_reason. To approximate the caller's max_tokens we bake it into
  // the system prompt as a hard instruction. This is a soft limit; the
  // model may ignore it, especially on synthesis/long-form tasks. The
  // returned `usage.output_tokens` is the truth — check it client-side.
  const limitNote = maxTokens
    ? ` HARD OUTPUT LIMIT: stay under ${maxTokens} output tokens (~${Math.round(maxTokens * 3.5)} characters). Stop early if you reach the limit.`
    : "";
  const systemPrompt = (system || "You are a precise assistant. Respond with exactly what is asked, nothing more.") + limitNote;

  // --json-schema mode uses an internal tool to enforce the schema, which
  // counts as a second turn. Bump --max-turns accordingly so the response
  // doesn't trip `error_max_turns`.
  const maxTurns = jsonSchema ? "2" : "1";

  const args = [
    "--model", modelId,
    "--print",
    "--output-format", "json",
    "--system-prompt", systemPrompt,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--allowedTools", "",
    "--exclude-dynamic-system-prompt-sections",
    "--max-turns", maxTurns,
  ];
  if (jsonSchema) {
    args.push("--json-schema", JSON.stringify(jsonSchema));
  }
  args.push("-p", prompt);

  const t0 = Date.now();
  // stdio: ignore stdin so the CLI doesn't wait 3s for piped input. The CLI
  // reads the prompt from -p, so stdin is never needed. Without this, peers
  // hit "/Users/hulki/.local/bin/claude exit 1: Warning: no stdin data received in 3s".
  const stdout = await runCommand(CLAUDE_BIN, args, { cwd: SAFE_CWD, timeoutMs, ignoreStdin: true });
  const latency_ms = Date.now() - t0;

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`claude CLI returned non-JSON: ${stdout.slice(0, 300)}`);
  }
  if (parsed.is_error || parsed.subtype !== "success") {
    throw new Error(`claude CLI error: ${parsed.subtype} ${parsed.result || ""}`);
  }
  const usage = parsed.usage || {};
  const outputTokens = usage.output_tokens || 0;
  // Warn when soft-limit was clearly ignored (>1.5x). Caller sees this in warnings[]
  const warnings = [];
  if (maxTokens && outputTokens > maxTokens * 1.5) {
    warnings.push(`output_tokens ${outputTokens} exceeded soft limit ${maxTokens} by ${Math.round((outputTokens / maxTokens) * 100 - 100)}% — CLI cannot enforce hard max_tokens, model ignored the hint`);
  }
  if (latency_ms > 15_000) {
    warnings.push(`latency ${latency_ms}ms exceeds 15s SLA — likely large input (>2KB) or model busy`);
  }
  return {
    // When --json-schema is used, the CLI puts the validated object in
    // `structured_output` and leaves `result` empty. Surface both so callers
    // can read whichever fits — text for free-form, json for schema-enforced.
    text: parsed.result || (parsed.structured_output ? JSON.stringify(parsed.structured_output) : ""),
    json: parsed.structured_output || null,
    model: modelId,
    logical_model: logicalModel,
    provider: "anthropic-cli",
    latency_ms,
    usage: {
      input_tokens: usage.input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      output_tokens: outputTokens,
      // Total billable for the plan = input + cache_creation + cache_read + output.
      // Cache_read is cheap on the API but here we surface it raw so callers
      // know how much went over the wire.
      total_tokens: (usage.input_tokens || 0)
                  + (usage.cache_creation_input_tokens || 0)
                  + (usage.cache_read_input_tokens || 0)
                  + outputTokens,
    },
    raw_cost_usd: parsed.total_cost_usd || 0,
    stop_reason: parsed.stop_reason || null,
    cli_session_id: parsed.session_id || null,
    warnings: warnings.length ? warnings : undefined,
  };
}

/**
 * Streaming variant of callAnthropicCli using --output-format stream-json.
 * Emits incremental events via onEvent:
 *   { type: "text",     text: "<delta>" }       — visible response token
 *   { type: "thinking", text: "<delta>" }       — extended-thinking token (only if include_thinking)
 *   { type: "rate_limit", info: {...} }         — claude CLI rate-limit hint
 *   { type: "done",     result: {final result object} }
 *   { type: "error",    error: "<message>" }
 *
 * Returns the final result object (same shape as callAnthropicCli).
 */
async function callAnthropicCliStream({ logicalModel, prompt, system, maxTokens, jsonSchema, timeoutMs, includeThinking }, onEvent) {
  const modelId = MODEL_MAP[logicalModel];
  if (!modelId) throw new Error(`unknown logical model: ${logicalModel}`);

  const limitNote = maxTokens
    ? ` HARD OUTPUT LIMIT: stay under ${maxTokens} output tokens (~${Math.round(maxTokens * 3.5)} characters). Stop early if you reach the limit.`
    : "";
  const systemPrompt = (system || "You are a precise assistant. Respond with exactly what is asked, nothing more.") + limitNote;
  const maxTurns = jsonSchema ? "2" : "1";

  const args = [
    "--model", modelId,
    "--print",
    // stream-json requires --verbose with --print
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--system-prompt", systemPrompt,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--allowedTools", "",
    "--exclude-dynamic-system-prompt-sections",
    "--max-turns", maxTurns,
  ];
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  args.push("-p", prompt);

  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: SAFE_CWD, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buf = "";
    let finalResult = null;
    let textBuf = "";
    let structuredOut = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude CLI stream timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === "rate_limit_event") {
        onEvent?.({ type: "rate_limit", info: msg.rate_limit_info });
        return;
      }
      if (msg.type === "stream_event" && msg.event?.type === "content_block_delta") {
        const delta = msg.event.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          textBuf += delta.text;
          onEvent?.({ type: "text", text: delta.text });
        } else if (delta?.type === "thinking_delta" && includeThinking && typeof delta.thinking === "string") {
          onEvent?.({ type: "thinking", text: delta.thinking });
        }
        return;
      }
      if (msg.type === "result") {
        // Final result aggregate.
        const usage = msg.usage || {};
        const latency_ms = Date.now() - t0;
        const outputTokens = usage.output_tokens || 0;
        const warnings = [];
        if (maxTokens && outputTokens > maxTokens * 1.5) {
          warnings.push(`output_tokens ${outputTokens} exceeded soft limit ${maxTokens} by ${Math.round((outputTokens / maxTokens) * 100 - 100)}% — CLI cannot enforce hard max_tokens, model ignored the hint`);
        }
        if (latency_ms > 15_000) {
          warnings.push(`latency ${latency_ms}ms exceeds 15s SLA — likely large input (>2KB) or model busy`);
        }
        if (msg.is_error || msg.subtype !== "success") {
          finalResult = null;
          onEvent?.({ type: "error", error: `${msg.subtype} ${msg.result || ""}` });
          return;
        }
        // structured_output appears under msg.structured_output for json-schema mode
        structuredOut = msg.structured_output ?? null;
        finalResult = {
          text: msg.result || (structuredOut ? JSON.stringify(structuredOut) : textBuf),
          json: structuredOut,
          model: modelId,
          logical_model: logicalModel,
          provider: "anthropic-cli",
          latency_ms,
          usage: {
            input_tokens: usage.input_tokens || 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
            cache_read_input_tokens: usage.cache_read_input_tokens || 0,
            output_tokens: outputTokens,
            total_tokens: (usage.input_tokens || 0)
                        + (usage.cache_creation_input_tokens || 0)
                        + (usage.cache_read_input_tokens || 0)
                        + outputTokens,
          },
          raw_cost_usd: msg.total_cost_usd || 0,
          stop_reason: msg.stop_reason || null,
          cli_session_id: msg.session_id || null,
          warnings: warnings.length ? warnings : undefined,
        };
      }
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) handleLine(buf);
      if (code !== 0 && !finalResult) {
        reject(new Error(`claude CLI stream exit ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      if (!finalResult) {
        reject(new Error("claude CLI stream finished without a result event"));
        return;
      }
      onEvent?.({ type: "done", result: finalResult });
      resolve(finalResult);
    });
  });
}

/**
 * Placeholder for direct API calls (when ANTHROPIC_API_KEY is set).
 * NOT used by default — Jörg wants everything on his Pro-Plan.
 */
async function callAnthropicApi({ logicalModel, prompt, system, maxTokens }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const modelId = MODEL_MAP[logicalModel];
  if (!modelId) throw new Error(`unknown logical model: ${logicalModel}`);

  const t0 = Date.now();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
      system: system || undefined,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const latency_ms = Date.now() - t0;
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`anthropic API ${r.status}: ${body.slice(0, 300)}`);
  }
  const json = await r.json();
  const text = (json.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  return {
    text,
    model: modelId,
    logical_model: logicalModel,
    provider: "anthropic-api",
    latency_ms,
    usage: {
      input_tokens: json.usage?.input_tokens || 0,
      cache_creation_input_tokens: json.usage?.cache_creation_input_tokens || 0,
      cache_read_input_tokens: json.usage?.cache_read_input_tokens || 0,
      output_tokens: json.usage?.output_tokens || 0,
      total_tokens: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0),
    },
    raw_cost_usd: null,  // API doesn't return this; caller computes if needed.
    stop_reason: json.stop_reason || null,
  };
}

/**
 * Skeleton for local Ollama backend. Caller passes `model: "local:llama3"` etc.
 */
async function callOllama({ localModel, prompt, system, maxTokens }) {
  throw new Error(`ollama provider not implemented yet (requested model: ${localModel})`);
}

/**
 * Public entry: route to provider based on logical model + env.
 *
 * Input:
 *   { model: "sonnet"|"haiku"|"opus"|"local:<name>",
 *     prompt: string,
 *     system?: string,
 *     max_tokens?: number,
 *     json_schema?: object,
 *     caller?: string,        // free-form, for tracking
 *     provider?: "auto"|"anthropic-cli"|"anthropic-api"|"ollama",
 *     timeout_ms?: number }
 */
export async function complete(input) {
  // Template-Resolution: caller passes `template: "<name>"` plus `input`
  // (or prompt). Template defaults fill in model/system/max_tokens; any
  // explicit caller field wins.
  const resolved = (input && input.template)
    ? applyTemplate(input.template, input)
    : (input || {});

  const {
    model = DEFAULT_MODEL,
    prompt,
    system,
    max_tokens,
    json_schema,
    provider = "auto",
    timeout_ms = DEFAULT_TIMEOUT_MS,
    template = null,
    cache = true,                       // default-on; opt-out via cache:false
    cache_ttl_ms = CACHE_DEFAULTS.DEFAULT_TTL_MS,
  } = resolved;
  if (!prompt || typeof prompt !== "string") {
    throw new Error("prompt required (string)");
  }

  // Cache lookup. Skip for local models (not implemented) and when caller
  // opted out. cache_ttl_ms<=0 also skips both lookup and write (no-cache mode).
  const cacheEnabled = cache && cache_ttl_ms > 0 && !String(model).startsWith("local:");
  const key = cacheEnabled ? cacheKey({ model, system, prompt, json_schema, max_tokens }) : null;
  if (key) {
    const hit = getCached(key);
    if (hit) {
      // Clone so callers can't mutate the cached object. Mark hit + zero
      // latency so callers can distinguish from a fresh call.
      return {
        ...hit,
        cache_status: "hit",
        cache_key: key.slice(0, 12),
        latency_ms: 0,
        ...(template ? { template } : {}),
      };
    }
  }

  // Local model routing
  if (typeof model === "string" && model.startsWith("local:")) {
    return callOllama({ localModel: model.slice("local:".length), prompt, system, maxTokens: max_tokens });
  }

  const knownLogical = MODEL_MAP[model];
  if (!knownLogical) {
    throw new Error(`unknown model: ${model}. Known: ${Object.keys(MODEL_MAP).join(", ")}, or local:<name>`);
  }

  // Provider resolution
  let chosen = provider;
  if (chosen === "auto") {
    // Prefer CLI (plan-based) unless user explicitly set API key + asked for it.
    chosen = "anthropic-cli";
  }
  let result;
  if (chosen === "anthropic-cli") {
    result = await callAnthropicCli({ logicalModel: model, prompt, system, maxTokens: max_tokens, jsonSchema: json_schema, timeoutMs: timeout_ms });
  } else if (chosen === "anthropic-api") {
    result = await callAnthropicApi({ logicalModel: model, prompt, system, maxTokens: max_tokens });
  } else {
    throw new Error(`unknown provider: ${chosen}`);
  }
  if (template) result.template = template;
  // Write to cache on success. Errors throw above and never reach here.
  if (key) {
    setCached(key, result, cache_ttl_ms);
    result.cache_status = "miss";
    result.cache_key = key.slice(0, 12);
  } else {
    result.cache_status = "skip";
  }
  return result;
}

/**
 * Streaming variant. Same input shape as complete() plus optional
 * `include_thinking: bool` (default false). Calls onEvent for each
 * chunk and returns the final result (same shape as complete()).
 *
 * Only the anthropic-cli provider supports streaming today. anthropic-api
 * and ollama fall back to a single done-event with the buffered result.
 */
export async function completeStream(input, onEvent) {
  const resolved = (input && input.template)
    ? applyTemplate(input.template, input)
    : (input || {});

  const {
    model = DEFAULT_MODEL,
    prompt,
    system,
    max_tokens,
    json_schema,
    provider = "auto",
    timeout_ms = DEFAULT_TIMEOUT_MS,
    template = null,
    include_thinking = false,
    cache = true,
    cache_ttl_ms = CACHE_DEFAULTS.DEFAULT_TTL_MS,
  } = resolved;
  if (!prompt || typeof prompt !== "string") throw new Error("prompt required (string)");

  // Cache lookup (same key shape as complete()). On hit, replay the cached
  // result as a single text-event + done-event so callers get the same SSE
  // shape they'd see on a miss.
  const cacheEnabled = cache && cache_ttl_ms > 0 && !String(model).startsWith("local:");
  const key = cacheEnabled ? cacheKey({ model, system, prompt, json_schema, max_tokens }) : null;
  if (key) {
    const hit = getCached(key);
    if (hit) {
      const cached = {
        ...hit,
        cache_status: "hit",
        cache_key: key.slice(0, 12),
        latency_ms: 0,
        ...(template ? { template } : {}),
      };
      if (cached.text) onEvent?.({ type: "text", text: cached.text });
      onEvent?.({ type: "done", result: cached });
      return cached;
    }
  }

  if (typeof model === "string" && model.startsWith("local:")) {
    // Fallback: ollama provider streams natively, but skeleton not yet built.
    const r = await callOllama({ localModel: model.slice("local:".length), prompt, system, maxTokens: max_tokens });
    onEvent?.({ type: "done", result: r });
    return r;
  }

  const knownLogical = MODEL_MAP[model];
  if (!knownLogical) throw new Error(`unknown model: ${model}. Known: ${Object.keys(MODEL_MAP).join(", ")}`);

  let chosen = provider === "auto" ? "anthropic-cli" : provider;
  let result;
  if (chosen === "anthropic-cli") {
    result = await callAnthropicCliStream({
      logicalModel: model, prompt, system, maxTokens: max_tokens,
      jsonSchema: json_schema, timeoutMs: timeout_ms,
      includeThinking: include_thinking,
    }, onEvent);
  } else if (chosen === "anthropic-api") {
    // API path doesn't stream (would need SSE client). Fall back to single done.
    result = await callAnthropicApi({ logicalModel: model, prompt, system, maxTokens: max_tokens });
    onEvent?.({ type: "done", result });
  } else {
    throw new Error(`unknown provider: ${chosen}`);
  }
  if (template) result.template = template;
  if (key && result) {
    setCached(key, result, cache_ttl_ms);
    result.cache_status = "miss";
    result.cache_key = key.slice(0, 12);
  } else if (result) {
    result.cache_status = "skip";
  }
  return result;
}

export { getStats as getCacheStats, clearCache } from "./llm-cache.mjs";

/**
 * List models the gateway currently knows about.
 */
export function listModels() {
  return {
    logical: Object.entries(MODEL_MAP).map(([logical, id]) => ({
      logical,
      cli_id: id,
      providers: ["anthropic-cli", process.env.ANTHROPIC_API_KEY ? "anthropic-api" : null].filter(Boolean),
    })),
    local: [],  // populated when ollama backend lands
    default: DEFAULT_MODEL,
  };
}

/**
 * Subprocess helper with stdout-capture + timeout.
 */
function runCommand(cmd, args, { cwd, timeoutMs, ignoreStdin = false }) {
  return new Promise((resolve, reject) => {
    const stdio = ignoreStdin ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
    const child = spawn(cmd, args, { cwd, env: process.env, stdio });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 400) || stdout.slice(0, 200)}`));
        return;
      }
      resolve(stdout);
    });
  });
}
