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
  const {
    model = DEFAULT_MODEL,
    prompt,
    system,
    max_tokens,
    json_schema,
    provider = "auto",
    timeout_ms = DEFAULT_TIMEOUT_MS,
  } = input || {};
  if (!prompt || typeof prompt !== "string") {
    throw new Error("prompt required (string)");
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
  if (chosen === "anthropic-cli") {
    return callAnthropicCli({ logicalModel: model, prompt, system, maxTokens: max_tokens, jsonSchema: json_schema, timeoutMs: timeout_ms });
  }
  if (chosen === "anthropic-api") {
    return callAnthropicApi({ logicalModel: model, prompt, system, maxTokens: max_tokens });
  }
  throw new Error(`unknown provider: ${chosen}`);
}

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
