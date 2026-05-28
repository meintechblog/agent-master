// LLM-Gateway Prompt-Templates.
//
// Why: zwei Peers (wallbox-master + camping-master) hatten unabhängig
// voneinander um vordefinierte system-prompts gebeten — wenn jeder Caller
// seine eigene commit-msg-Anweisung schreibt, drifted das Format
// repo-übergreifend. Templates schaffen Konsistenz.
//
// Usage:
//   POST /api/llm/complete  { template: "commit-msg", input: "<git diff>", caller: "foo" }
//   Anything the caller passes (system/model/max_tokens) overrides the template.
//
// Conventions:
//   - system  : final system prompt to ship to the model
//   - model   : "sonnet" | "haiku" | "opus" (logical id)
//   - max_tokens : soft hint; CLI cannot hard-enforce, baked into system
//   - input_format : free-form note for callers, NOT sent to the model

export const TEMPLATES = {
  "commit-msg": {
    system: "You are a Conventional-Commits generator. Read the provided git diff and respond with a single commit message: one subject line (≤72 chars, type(scope)?: subject — lowercase imperative, no trailing period) followed by an empty line and 1–3 short body lines explaining the why (not the what). Output ONLY the commit message — no code fences, no preamble, no analysis. If the diff is empty or nonsensical, respond with exactly: NOMSG.",
    model: "sonnet",
    max_tokens: 200,
    input_format: "git diff output (`git diff --cached` or `git diff HEAD`)",
    description: "Generiert Conventional-Commits aus einem Diff.",
  },

  "log-summary": {
    system: "You are a log-summary assistant. Read the N log lines provided and respond in German with 3–5 short bullet points (each ≤120 chars) that state facts visible in the log: errors, warnings, restarts, state changes. Restate values verbatim from the log — do NOT compute aggregates, averages, or counts unless the log itself contains them. If a line is ambiguous, drop it. Output ONLY the bullets (lines starting with `- `), no preamble, no headlines.",
    model: "haiku",
    max_tokens: 300,
    input_format: "letzte N log-Zeilen (typisch 50–200 Zeilen)",
    description: "Verdichtet Logs in deutsche Bullet-Liste, halluzinations-resistent.",
  },

  "german-ui": {
    system: "Du bist ein Übersetzer/Polierer für deutsche UI-Strings (Toasts, Errors, Buttons, Labels). Du bekommst einen Eingabe-String und antwortest mit GENAU EINEM polierten deutschen String — natürliche Formulierung, korrekte Umlaute (ä ö ü ß), keine Anglizismen wo Deutsch existiert, du-Form sofern Kontext nicht förmlich. KEINE Anführungszeichen, keine Erklärung, kein Markdown. Wenn der Eingabe-String bereits sauber ist: gib ihn unverändert zurück. Wenn er nicht übersetzbar ist (z.B. nur ein Code/Bezeichner): gib ihn unverändert zurück.",
    model: "haiku",
    max_tokens: 100,
    input_format: "ein einzelner UI-String (Toast/Error/Label/Button)",
    description: "Poliert deutsche UI-Strings (Umlaute, Du-Form, kein Denglisch).",
  },

  "trivial-doc-edit": {
    system: "You are a markdown editor. The caller's prompt contains a markdown snippet plus a tiny instruction (typo fix, link update, single-line addition). Apply ONLY the requested change. Respond with the full updated snippet — no diff, no commentary, no code fences around the whole output (keep code fences that are part of the markdown itself). Preserve existing formatting, indentation, and line endings exactly. If the instruction is ambiguous or would require >1 paragraph of change, respond with exactly: TOO_BIG.",
    model: "haiku",
    max_tokens: 800,
    input_format: "instruction + markdown snippet (typisch <2KB)",
    description: "Mini-Patches an Markdown (Typos, Links, einzelne Zeilen).",
  },

  "structured-extraction": {
    system: "You are an extraction engine. You will be given free-form text. Respond with ONLY a JSON object matching the schema specified by the caller via `json_schema`. Restate values verbatim from the input — do NOT infer, normalize, or compute fields the input doesn't mention. Use null for missing fields if the schema allows it. No prose, no markdown, no code fences.",
    model: "sonnet",
    max_tokens: 600,
    input_format: "free-form Text + json_schema im Body",
    description: "Free-Text → strukturiertes JSON via json_schema (caller MUSS json_schema mitsenden).",
  },

  "vendor-detect": {
    system: "You are a device/vendor classification engine. You will be given the raw output of a probe (HTTP response, banner, mDNS announce, JSON-RPC reply, etc.). Respond with a JSON object: { vendor: \"<lowercase-slug>\", model: \"<string|null>\", confidence: \"high\"|\"medium\"|\"low\", evidence: \"<short quote from the input that proves it>\" }. If you cannot identify the vendor with at least low confidence, respond { vendor: \"unknown\", model: null, confidence: \"low\", evidence: \"<short summary why>\" }. No prose outside the JSON.",
    model: "haiku",
    max_tokens: 200,
    input_format: "probe-Output (HTTP-Response/Banner/JSON)",
    description: "Klassifiziert ein Probe-Result auf Vendor/Modell (Hybrid-Pattern: Regex first, dann LLM-Fallback).",
  },

  "severity-triage": {
    system: "You are a log-severity triage classifier. You will be given one log event (line, error message, or alert). Respond with a JSON object: { severity: \"low\"|\"medium\"|\"high\", reason: \"<≤120 char justification, verbatim quotes from the event>\", actionable: true|false }. \"high\" = production-affecting or data-loss; \"medium\" = degraded but recoverable; \"low\" = noisy/informational. Restate values from the input, do not guess context.",
    model: "haiku",
    max_tokens: 150,
    input_format: "ein log-event (eine Zeile / Error-Message / Alert)",
    description: "Klassifiziert ein log-event in low/medium/high mit Begründung.",
  },
};

/**
 * Apply a template's defaults to a call. Caller-provided fields win.
 * Returns the merged { model, system, max_tokens, prompt }.
 *
 * `input` (preferred for templates) is renamed to `prompt` so the
 * existing gateway can stay agnostic. `prompt` itself also works
 * for callers that already drive prompt explicitly.
 */
export function applyTemplate(name, body) {
  const tpl = TEMPLATES[name];
  if (!tpl) {
    throw new Error(`unknown template: ${name}. Known: ${Object.keys(TEMPLATES).join(", ")}`);
  }
  const prompt = body.prompt ?? body.input;
  if (!prompt || typeof prompt !== "string") {
    throw new Error(`template "${name}" needs prompt or input (string)`);
  }
  return {
    ...body,
    template: name,
    model: body.model ?? tpl.model,
    system: body.system ?? tpl.system,
    max_tokens: body.max_tokens ?? tpl.max_tokens,
    prompt,
  };
}

/**
 * List templates for the discovery endpoint. Strips heavy `system`
 * field by default so the list stays compact; include_system=true
 * returns the full prompt.
 */
export function listTemplates(includeSystem = false) {
  return Object.entries(TEMPLATES).map(([name, tpl]) => ({
    name,
    description: tpl.description,
    model: tpl.model,
    max_tokens: tpl.max_tokens,
    input_format: tpl.input_format,
    ...(includeSystem ? { system: tpl.system } : {}),
  }));
}
