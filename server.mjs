#!/usr/bin/env node
// agent-master server — localhost:7890
// Aggregiert claude-peers broker + capability registry + spawn/stop + ccusage + SSE.
// LAN-only, no auth. Doku: ~/codex/agent-master/README.md

import http from "node:http";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import { complete as llmComplete, completeStream as llmCompleteStream, listModels as llmListModels, getCacheStats as llmGetCacheStats, clearCache as llmClearCache, getCircuitStats as llmGetCircuitStats, forceCloseCircuit as llmForceCloseCircuit, forceOpenCircuit as llmForceOpenCircuit, setAuditSink as llmSetAuditSink } from "./lib/llm-gateway.mjs";
import { listTemplates as llmListTemplates } from "./lib/llm-templates.mjs";
import { checkForUpdate, startApply, readState as readUpdateState, getSelfInfo } from "./lib/updater.mjs";

// === LLM live-usage tracking (in-memory, for sidebar dots) ===
// Rolling 24h window. Updated on every /api/llm/complete call. Pruned on read.
const LLM_LIVE_PULSE_MS = 15_000;     // "pulsing dot" if call happened within this
const LLM_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;  // "recent activity" — static dot
const llmUsageMap = new Map();        // caller → { calls, total_tokens, last_call_at, last_call_model, by_model, latencies }

function bumpLlmUsage(caller, model, totalTokens, latencyMs) {
  const now = Date.now();
  const entry = llmUsageMap.get(caller) || {
    calls: 0, total_tokens: 0, last_call_at: 0, last_call_model: null,
    by_model: {}, latencies: [],
  };
  entry.calls += 1;
  entry.total_tokens += totalTokens || 0;
  entry.last_call_at = now;
  entry.last_call_model = model;
  entry.by_model[model] = (entry.by_model[model] || 0) + 1;
  entry.latencies.push(latencyMs || 0);
  if (entry.latencies.length > 20) entry.latencies = entry.latencies.slice(-20);  // rolling avg
  llmUsageMap.set(caller, entry);
  // Push instantly to all SSE clients so the sidebar dot lights up on the same
  // tick the call completes — defined later in the file so wrap in try/catch
  // for module-init ordering safety.
  try { broadcastLlmLive(); } catch {}
}

function pruneLlmUsage() {
  const cutoff = Date.now() - LLM_RECENT_WINDOW_MS;
  for (const [caller, entry] of llmUsageMap) {
    if (entry.last_call_at < cutoff) llmUsageMap.delete(caller);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.AGENT_HUB_PORT || "7890", 10);
const BROKER_URL = process.env.CLAUDE_PEERS_BROKER || "http://localhost:7899";
const REGISTRY_PATH = path.join(__dirname, "data", "registry.json");
const REGISTRY_EXAMPLE_PATH = path.join(__dirname, "data", "registry.example.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SPAWN_LOG = path.join(__dirname, "data", "spawn.log");
const SKILLS_DIR = path.join(process.env.HOME, ".claude", "skills");
const PLUGINS_CACHE_DIR = path.join(process.env.HOME, ".claude", "plugins", "cache");
const SKILLS_CACHE_MS = 5 * 60 * 1000;

// --- New-peer briefing ---
// Path of THIS repo, so the briefing loop can skip Hulki's own session.
const SELF_CWD = __dirname;
const BRIEFING_MD_PATH = path.join(__dirname, "data", "peer-briefing.md");
const BRIEFED_PEERS_PATH = path.join(__dirname, "data", "briefed-peers.json");
const BRIEFING_POLL_MS = 30 * 1000;

// --- Skill-usage logging to InfluxDB ---
// Spawns scripts/scan-skill-usage.mjs with --since-ms so each tick only
// re-scans recently-modified transcripts. Idempotent at the InfluxDB level
// (timestamp+tags), so the lookback can comfortably overlap the interval.
const SKILL_USAGE_SCRIPT = path.join(__dirname, "scripts", "scan-skill-usage.mjs");
const SKILL_USAGE_LEGACY_TOKEN_FILE = path.join(__dirname, "data", ".influx-token");
const SKILL_USAGE_POLL_MS = 5 * 60 * 1000;
const SKILL_USAGE_LOOKBACK_MS = 6 * 60 * 1000;

// --- Health monitor ---
// Polls per-box /api/health/digest endpoints declared in agents' health_monitor
// config (registry.json). Detects transitions, writes time-series to InfluxDB
// (measurement: service_health), and forwards alerts through the WA-push
// gateway. Dormant when no agent has health_monitor.enabled=true with boxes.
const HEALTH_STATE_PATH = path.join(__dirname, "data", "health-state.json");
const HEALTH_POLL_MS = 60 * 1000;
const HEALTH_FETCH_TIMEOUT_MS = 10 * 1000;
const HEALTH_SEVERITY_RANK = { ok: 0, info: 0, warn: 1, error: 2 };

// --- WA-Push gateway ---
// Central WhatsApp push endpoint that other repos (mqtt-master health alerts,
// future energy/venusos alarms) call instead of writing wa-bridge outbox
// files themselves. Keeps dedup, rate-limit, and rendering in one place.
const WA_OUTBOX_DIR = path.join(process.env.HOME, "codex", "wa-bridge", "data", "outbox");
// Operator's default WA target — never commit a real number. Read from env,
// else from gitignored data/.wa-phone, else empty (wa-push then requires an
// explicit to_e164 per call).
const WA_PHONE_FILE = path.join(__dirname, "data", ".wa-phone");
const WA_DEFAULT_PHONE = process.env.WA_DEFAULT_PHONE
  || (existsSync(WA_PHONE_FILE) ? readFileSync(WA_PHONE_FILE, "utf8").trim() : "");
const WA_DEDUP_TTL_MS = 10 * 60 * 1000;
const WA_RATE_LIMIT_COUNT = 30;
const WA_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const WA_SEVERITY_PREFIX = { info: "ℹ️", warn: "⚠️", error: "🚨", recovered: "✅" };

// --- Sources (InfluxDB and future others) ---
// data/sources.json holds the user-managed list of data sources. Schema:
//   { sources: [ { id, name, type, url, org, bucket, token, default, created_at } ] }
// The "default" flag picks which source the skill-usage loop & aggregation
// API talk to. Token never leaves the server — list/read endpoints redact it.
const SOURCES_PATH = path.join(__dirname, "data", "sources.json");

const USAGE_CACHE_MS = 5 * 60 * 1000;
const HEALTH_CACHE_MS = 60 * 1000;
const BROADCAST_MS = 3000;
const SOFT_STOP_GRACE_MS = 5 * 60 * 1000;
const SOFT_STOP_TICK_MS = 15 * 1000;
const SOFT_STOP_PROMPT = `Speichere alles aus der heutigen Session vernünftig ab, damit ich mal ein /clear machen kann und mit "weiter" Dann nahtlos mit dir weiterarbeiten kann - und denk dran ans Committen und Pushen und was egal, was nicht alles, damit eben alles rund ist. Wenn sonst noch was wichtiges offen ist -> autonom durchziehen. Schau, dass GitHub auch gerade gezogen ist und die Dokumentation dort passt.

(Soft-Stop von Hulki-Hub. Du hast 5 Min. Wenn du mehr Zeit brauchst, ruf einmal:
  curl -X POST http://localhost:7890/api/soft-stop-extend -H 'Content-Type: application/json' -d '{"agent":"<KEY>"}'
und du bekommst +5 Min — danach erfolgt ein hard-stop (SIGTERM + close tab) automatisch.)`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const sseClients = new Set();
let usageCache = { data: null, fetched_at: 0 };
let healthCache = { data: null, fetched_at: 0 };

// Maps repoKey → window-id from the spawn AppleScript. Needed because the
// claudepeers expect-wrapper introduces a second PTY between the Terminal
// tab and the claude process: the tab's tty differs from peer.tty in the
// broker, so we can't tty-match anymore. We trust the window-id we captured
// at spawn time instead.
const SPAWNED_WINDOWS_PATH = path.join(__dirname, "data", "spawned-windows.json");
const spawnedWindows = new Map();
try {
  if (existsSync(SPAWNED_WINDOWS_PATH)) {
    const raw = JSON.parse(await fs.readFile(SPAWNED_WINDOWS_PATH, "utf8"));
    for (const [k, v] of Object.entries(raw)) spawnedWindows.set(k, v);
  }
} catch (e) {
  console.warn("[spawned-windows] could not load:", e.message);
}
function persistSpawnedWindows() {
  fs.writeFile(SPAWNED_WINDOWS_PATH, JSON.stringify(Object.fromEntries(spawnedWindows), null, 2)).catch(() => {});
}

// Soft-stop state: repoKey → { started_at, hard_stop_at, extension_used, peer_id, reminded }
// Persisted to disk so a server restart doesn't lose pending shutdowns.
const SOFT_STOP_STATE_PATH = path.join(__dirname, "data", "soft-stop-state.json");
const softStopState = new Map();
try {
  if (existsSync(SOFT_STOP_STATE_PATH)) {
    const raw = JSON.parse(await fs.readFile(SOFT_STOP_STATE_PATH, "utf8"));
    for (const [k, v] of Object.entries(raw)) softStopState.set(k, v);
  }
} catch (e) {
  console.warn("[soft-stop] could not load state:", e.message);
}
function persistSoftStopState() {
  fs.writeFile(SOFT_STOP_STATE_PATH, JSON.stringify(Object.fromEntries(softStopState), null, 2)).catch(() => {});
}

// ── Skills (parses ~/.claude/skills/<name>/SKILL.md frontmatter) ───────────
let skillsCache = { data: null, fetched_at: 0 };

// Minimal YAML-frontmatter parser, just enough for our needs.
// Handles: `key: value`, `key: "quoted value"`, multiline block scalars (`>` / `|`),
// and `key:` followed by `  - item` lines (string arrays).
function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end < 0) return null;
  const result = {};
  let currentKey = null;
  let currentMode = null; // "array" or "block"
  let blockIndent = 0;
  let blockBuf = [];
  const flushBlock = () => {
    if (currentMode === "block" && currentKey) {
      result[currentKey] = blockBuf.join(" ").trim();
    }
    currentMode = null;
    currentKey = null;
    blockBuf = [];
  };
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Array item under a key
    if (currentMode === "array" && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, "");
      result[currentKey] = result[currentKey] || [];
      result[currentKey].push(val);
      continue;
    }
    // Block scalar continuation (indented under a > or |)
    if (currentMode === "block") {
      const m = line.match(/^(\s+)(.*)$/);
      if (m && m[1].length >= blockIndent) {
        blockBuf.push(m[2]);
        continue;
      }
      flushBlock();
      // fall through to parse this line as a new key
    }
    // New key
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val === "") {
      // Could be array, block, or empty. Look at next non-empty line.
      const next = lines.slice(i + 1, end).find((l) => l.trim());
      if (next && /^\s+-\s+/.test(next)) {
        currentMode = "array"; currentKey = key; continue;
      }
      result[key] = "";
      continue;
    }
    if (val === ">" || val === "|") {
      currentMode = "block"; currentKey = key;
      blockIndent = 2; blockBuf = [];
      continue;
    }
    // Strip surrounding quotes
    val = val.trim().replace(/^["']|["']$/g, "");
    result[key] = val;
  }
  if (currentMode === "block") flushBlock();
  return result;
}

// Normalize `allowed-tools` from frontmatter into a string[]. YAML inline-style
// (`allowed-tools: Read, Bash`) produces a string; block-style (`- Read`) gives
// us an array directly. The UI expects always-array.
function normalizeAllowedTools(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function clusterForSkill(name, pluginPrefix) {
  if (pluginPrefix === "browse") return "Browser";
  if (pluginPrefix === "frontend-design") return "Frontend";
  if (name.startsWith("gsd-")) return "GSD";
  if (["thermomix-master", "chatgpt-image-restyle"].includes(name)) return "Workflow";
  return "Utility";
}

// Sub-cluster ("group") inside a cluster, so 67 GSD skills don't drown the UI.
// GSD groups mirror the official `gsd-ns-*` namespaces (review/ideate/manage/
// project/context/workflow); see ~/.claude/plugins/cache for the source.
// Browser groups split by intent (drive vs. capture vs. prospect vs. platform).
// Unknown → "Other" so we never lose a skill.
const GSD_GROUPS = {
  Workflow: new Set([
    "discuss-phase", "plan-phase", "execute-phase", "verify-work", "phase",
    "progress", "autonomous", "mvp-phase", "ultraplan-phase",
    "ai-integration-phase", "ui-phase", "pr-branch", "validate-phase",
    "add-tests", "pause-work", "resume-work", "spec-phase",
  ]),
  Review: new Set([
    "code-review", "debug", "audit-fix", "audit-uat", "audit-milestone",
    "secure-phase", "eval-review", "ui-review", "plan-review-convergence",
    "review", "review-backlog",
  ]),
  Ideate: new Set(["explore", "sketch", "spike", "capture"]),
  Manage: new Set([
    "config", "workspace", "workstreams", "thread", "update", "ship", "inbox",
    "settings", "surface", "manager", "help", "health", "forensics", "fast",
    "quick", "undo", "cleanup", "import",
  ]),
  Project: new Set([
    "new-project", "new-milestone", "complete-milestone", "milestone-summary",
    "profile-user", "stats",
  ]),
  Context: new Set([
    "map-codebase", "graphify", "docs-update", "extract-learnings", "ingest-docs",
  ]),
};

const BROWSE_GROUPS = {
  Drive:    new Set(["autobrowse", "browser", "safe-browser", "ui-test"]),
  Capture:  new Set(["search", "fetch", "browser-trace", "browser-to-api", "cookie-sync"]),
  Prospect: new Set(["company-research", "event-prospecting"]),
  Platform: new Set(["browserbase-cli", "functions"]),
};

function groupForSkill(baseName, cluster, pluginPrefix) {
  if (cluster === "GSD") {
    // baseName is "gsd-discuss-phase" / "gsd-ns-review" — strip the prefix
    // before matching against GSD_GROUPS (which use the bare verb).
    const stem = baseName.replace(/^gsd-/, "");
    if (stem.startsWith("ns-")) return "Namespaces";
    for (const [group, set] of Object.entries(GSD_GROUPS)) {
      if (set.has(stem)) return group;
    }
    return "Other";
  }
  if (cluster === "Browser") {
    for (const [group, set] of Object.entries(BROWSE_GROUPS)) {
      if (set.has(baseName)) return group;
    }
    return "Other";
  }
  return null; // no sub-grouping for tiny clusters
}

// Scan ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<slug>/SKILL.md
async function scanPluginSkills() {
  const skills = [];
  if (!existsSync(PLUGINS_CACHE_DIR)) return skills;
  const marketplaces = await fs.readdir(PLUGINS_CACHE_DIR, { withFileTypes: true });
  for (const mp of marketplaces) {
    if (!mp.isDirectory()) continue;
    const mpPath = path.join(PLUGINS_CACHE_DIR, mp.name);
    const plugins = await fs.readdir(mpPath, { withFileTypes: true });
    for (const pl of plugins) {
      if (!pl.isDirectory()) continue;
      const plPath = path.join(mpPath, pl.name);
      const versions = await fs.readdir(plPath, { withFileTypes: true });
      // Pick the version dir that actually contains a skills/ subfolder.
      for (const ver of versions) {
        if (!ver.isDirectory()) continue;
        const skillsDir = path.join(plPath, ver.name, "skills");
        if (!existsSync(skillsDir)) continue;
        const skillDirs = await fs.readdir(skillsDir, { withFileTypes: true });
        for (const sd of skillDirs) {
          if (!sd.isDirectory()) continue;
          const mdPath = path.join(skillsDir, sd.name, "SKILL.md");
          if (!existsSync(mdPath)) continue;
          try {
            const md = await fs.readFile(mdPath, "utf8");
            const fm = parseFrontmatter(md) || {};
            const baseName = fm.name || sd.name;
            const displayName = `${pl.name}:${baseName}`;
            const cluster = clusterForSkill(baseName, pl.name);
            skills.push({
              name: displayName,
              slug: sd.name,
              plugin: pl.name,
              marketplace: mp.name,
              description: fm.description || "",
              argument_hint: fm["argument-hint"] || null,
              allowed_tools: normalizeAllowedTools(fm["allowed-tools"]),
              cluster,
              group: groupForSkill(baseName, cluster, pl.name),
              path: mdPath,
            });
          } catch (err) {
            console.warn(`[skills] could not parse ${mdPath}:`, err.message);
          }
        }
      }
    }
  }
  return skills;
}

async function readSkills({ force = false } = {}) {
  const now = Date.now();
  if (!force && skillsCache.data && now - skillsCache.fetched_at < SKILLS_CACHE_MS) {
    return { ...skillsCache.data, cached: true, age_ms: now - skillsCache.fetched_at };
  }
  const skills = [];
  if (existsSync(SKILLS_DIR)) {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillMdPath = path.join(SKILLS_DIR, e.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      try {
        const md = await fs.readFile(skillMdPath, "utf8");
        const fm = parseFrontmatter(md) || {};
        const baseName = fm.name || e.name;
        const cluster = clusterForSkill(baseName, null);
        skills.push({
          name: baseName,
          slug: e.name,
          plugin: null,
          marketplace: null,
          description: fm.description || "",
          argument_hint: fm["argument-hint"] || null,
          allowed_tools: normalizeAllowedTools(fm["allowed-tools"]),
          cluster,
          group: groupForSkill(baseName, cluster, null),
          path: skillMdPath,
        });
      } catch (err) {
        console.warn(`[skills] could not parse ${skillMdPath}:`, err.message);
      }
    }
  }
  // Also scan installed plugins for SKILL.md files.
  try {
    const pluginSkills = await scanPluginSkills();
    skills.push(...pluginSkills);
  } catch (err) {
    console.warn("[skills] plugin scan failed:", err.message);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const clusters = {};
  const groups = {}; // { cluster: { group: count } } — drives the UI sub-sections.
  for (const s of skills) {
    clusters[s.cluster] = (clusters[s.cluster] || 0) + 1;
    if (s.group) {
      groups[s.cluster] = groups[s.cluster] || {};
      groups[s.cluster][s.group] = (groups[s.cluster][s.group] || 0) + 1;
    }
  }
  const data = {
    skills,
    clusters,
    groups,
    count: skills.length,
    dir: SKILLS_DIR,
    generated_at: new Date().toISOString(),
  };
  skillsCache = { data, fetched_at: now };
  return { ...data, cached: false, age_ms: 0 };
}

// Strip YAML frontmatter from a SKILL.md and return the body. Used by the
// /api/skills/body endpoint to feed the detail-panel in the Skills tab.
function stripFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
  }
  return text;
}

// Resolve a user-supplied path against the two trusted roots and return the
// absolute path, or null if it escapes both. Prevents path-traversal — only
// files under ~/.claude/skills/ or ~/.claude/plugins/cache/ may be read.
function safeSkillPath(input) {
  if (!input) return null;
  const abs = path.resolve(input);
  const userRoot = path.resolve(SKILLS_DIR) + path.sep;
  const pluginRoot = path.resolve(PLUGINS_CACHE_DIR) + path.sep;
  if (!abs.startsWith(userRoot) && !abs.startsWith(pluginRoot)) return null;
  if (path.basename(abs) !== "SKILL.md") return null;
  return abs;
}

async function sendChannelMessage(toPeerId, text) {
  const r = await fetch(`${BROKER_URL}/send-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_id: "agent-master-hub", to_id: toPeerId, text }),
  });
  if (!r.ok) throw new Error(`broker send-message ${r.status}: ${await r.text()}`);
  return r.json();
}

async function readRegistry() {
  const target = existsSync(REGISTRY_PATH) ? REGISTRY_PATH : REGISTRY_EXAMPLE_PATH;
  return JSON.parse(await fs.readFile(target, "utf8"));
}

// === New-peer briefing ===
//
// Background loop: every BRIEFING_POLL_MS, fetch the peer list and send a
// one-time welcome briefing to any peer_id we haven't seen before. The
// briefing content lives in data/peer-briefing.md (editable without redeploy);
// who-was-briefed-when persists in data/briefed-peers.json so a server restart
// does not re-spam everyone.
//
// Hulki's own session (= this repo's cwd) is recorded as briefed but never
// actually sent — we don't brief ourselves.

let briefedPeers = new Map(); // peer_id → { cwd, briefed_at, skipped? }

async function loadBriefedPeers() {
  try {
    if (existsSync(BRIEFED_PEERS_PATH)) {
      const raw = JSON.parse(await fs.readFile(BRIEFED_PEERS_PATH, "utf8"));
      briefedPeers = new Map(Object.entries(raw));
    }
  } catch (err) {
    console.warn("[briefing] could not load briefed-peers.json:", err.message);
  }
}

async function saveBriefedPeers() {
  try {
    const obj = Object.fromEntries(briefedPeers);
    await fs.writeFile(BRIEFED_PEERS_PATH, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.warn("[briefing] could not save briefed-peers.json:", err.message);
  }
}

async function getBriefingText() {
  if (!existsSync(BRIEFING_MD_PATH)) return null;
  const txt = (await fs.readFile(BRIEFING_MD_PATH, "utf8")).trim();
  return txt || null;
}

async function briefPeer(peer, { force = false } = {}) {
  if (!peer?.id) return { sent: false, reason: "no_id" };
  if (!force && briefedPeers.has(peer.id)) return { sent: false, reason: "already_briefed" };
  // Hulki doesn't brief herself — record as skipped so the loop ignores her.
  if (peer.cwd === SELF_CWD) {
    briefedPeers.set(peer.id, { cwd: peer.cwd, briefed_at: new Date().toISOString(), skipped: "self" });
    await saveBriefedPeers();
    return { sent: false, reason: "self" };
  }
  const text = await getBriefingText();
  if (!text) return { sent: false, reason: "no_briefing_file" };
  try {
    await sendChannelMessage(peer.id, text);
    briefedPeers.set(peer.id, { cwd: peer.cwd, briefed_at: new Date().toISOString() });
    await saveBriefedPeers();
    console.log(`[briefing] briefed peer ${peer.id} (${peer.cwd})`);
    auditEvent("briefing.sent", { target: peer.id, cwd: peer.cwd, forced: String(!!force) }, `Briefing → ${path.basename(peer.cwd || "?")}`).catch(() => {});
    return { sent: true };
  } catch (err) {
    console.warn(`[briefing] could not brief ${peer.id}:`, err.message);
    return { sent: false, reason: "send_failed", error: err.message };
  }
}

async function briefingTick() {
  try {
    const peers = await fetchPeers();
    for (const p of peers) await briefPeer(p);
  } catch (err) {
    console.warn("[briefing] tick failed:", err.message);
  }
}

let briefingTimer = null;
async function startBriefingLoop() {
  if (briefingTimer) return;
  await loadBriefedPeers();
  await briefingTick();
  briefingTimer = setInterval(briefingTick, BRIEFING_POLL_MS);
}

// === Sources persistence ===
//
// One-time migration: if data/sources.json doesn't exist but the legacy
// data/.influx-token does, wrap the legacy config into a single default
// source so the user keeps logging without manual setup.

let sourcesCache = null;

function genSourceId() {
  return "src_" + Math.random().toString(36).slice(2, 10);
}

async function loadSources() {
  if (sourcesCache) return sourcesCache;
  if (existsSync(SOURCES_PATH)) {
    try {
      sourcesCache = JSON.parse(await fs.readFile(SOURCES_PATH, "utf8"));
    } catch (err) {
      console.warn("[sources] could not parse sources.json:", err.message);
      sourcesCache = { sources: [] };
    }
  } else if (existsSync(SKILL_USAGE_LEGACY_TOKEN_FILE)) {
    // Migrate legacy single-token setup.
    const token = (await fs.readFile(SKILL_USAGE_LEGACY_TOKEN_FILE, "utf8")).trim();
    sourcesCache = {
      sources: [{
        id: genSourceId(),
        name: "Central InfluxDB (172.25.0.111)",
        type: "influxdb2",
        url: process.env.INFLUX_URL || "http://172.25.0.111:8086",
        org: process.env.INFLUX_ORG || "meintechblog",
        bucket: process.env.INFLUX_BUCKET || "default",
        token,
        default: true,
        created_at: new Date().toISOString(),
      }],
    };
    await saveSources();
    console.log("[sources] migrated data/.influx-token into data/sources.json");
  } else {
    sourcesCache = { sources: [] };
  }
  return sourcesCache;
}

async function saveSources() {
  if (!sourcesCache) sourcesCache = { sources: [] };
  await fs.writeFile(SOURCES_PATH, JSON.stringify(sourcesCache, null, 2), { mode: 0o600 });
}

async function getDefaultSource(type = "influxdb2") {
  const cfg = await loadSources();
  const matches = cfg.sources.filter((s) => s.type === type);
  return matches.find((s) => s.default) || matches[0] || null;
}

function redactSource(s) {
  if (!s) return null;
  const { token, ...rest } = s;
  return { ...rest, has_token: !!token, token_preview: token ? token.slice(0, 6) + "…" + token.slice(-4) : null };
}

// === Skill-usage InfluxDB shipping ===
//
// Resolves the influx token from the default influxdb2 source in
// sources.json. If none is configured, the loop logs once and stays
// dormant — no crash. Env vars INFLUX_TOKEN/_URL/_ORG/_BUCKET still
// override for ad-hoc / CI use.

let skillUsageState = { last_run_at: null, last_summary: null, last_error: null, token_present: false };

async function resolveInfluxToken() {
  if (process.env.INFLUX_TOKEN) return process.env.INFLUX_TOKEN.trim();
  const src = await getDefaultSource("influxdb2");
  return src?.token || null;
}

async function resolveInfluxTarget() {
  const src = await getDefaultSource("influxdb2");
  return {
    url:    process.env.INFLUX_URL    || src?.url    || "http://172.25.0.111:8086",
    org:    process.env.INFLUX_ORG    || src?.org    || "meintechblog",
    bucket: process.env.INFLUX_BUCKET || src?.bucket || "default",
    source_id: src?.id || null,
    source_name: src?.name || null,
  };
}

async function skillUsageTick() {
  const token = await resolveInfluxToken();
  if (!token) {
    if (skillUsageState.token_present !== false || skillUsageState.last_run_at == null) {
      console.warn("[skill-usage] no default InfluxDB source configured — loop dormant");
    }
    skillUsageState = { ...skillUsageState, token_present: false, last_run_at: new Date().toISOString() };
    return;
  }
  skillUsageState.token_present = true;
  const target = await resolveInfluxTarget();
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SKILL_USAGE_SCRIPT, "--since-ms", String(SKILL_USAGE_LOOKBACK_MS)], {
        env: { ...process.env, INFLUX_TOKEN: token, INFLUX_URL: target.url, INFLUX_ORG: target.org, INFLUX_BUCKET: target.bucket },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });
    const summary = (result.out.match(/\[scan\] wrote .*/g) || []).pop() || "(no points)";
    if (result.code !== 0) {
      console.warn(`[skill-usage] scan exit ${result.code}: ${result.out.slice(-300).trim()}`);
      skillUsageState.last_error = `exit ${result.code}: ${result.out.slice(-200)}`;
    } else {
      console.log(`[skill-usage] ${summary}`);
      skillUsageState.last_error = null;
    }
    skillUsageState.last_summary = summary;
    skillUsageState.last_run_at = new Date().toISOString();
  } catch (err) {
    console.warn("[skill-usage] tick failed:", err.message);
    skillUsageState.last_error = err.message;
    skillUsageState.last_run_at = new Date().toISOString();
  }
}

let skillUsageTimer = null;
async function startSkillUsageLoop() {
  if (skillUsageTimer) return;
  await skillUsageTick();
  skillUsageTimer = setInterval(skillUsageTick, SKILL_USAGE_POLL_MS);
}

// === External-backend model discovery ===
//
// Why: Jonas will load more models onto his Mac Studio over time. We poll
// /v1/models on each registered external backend every 5 min and diff against
// the model list persisted in data/external-llm.json. Diffs surface as
// audit events ("Klick exposes new model 'qwen3-vl'") so we notice without
// having to read upstream-config notes by hand. Never auto-edits the config
// — humans decide whether a newly-visible model should become a default.
const EXTERNAL_DISCOVERY_POLL_MS = 5 * 60 * 1000;
const externalDiscoveryState = {
  last_run_at: null,
  last_summary: null,
  last_error: null,
  // backend → Set of model ids seen on the last poll. Used to detect adds/removes.
  seen_models: new Map(),
};

// backend-heartbeat tracking: per-backend timestamps so the routing layer
// and UI can see "klick was last reachable 8 minutes ago" without re-probing.
// Updated by the discovery loop only — no extra network traffic.
const backendHeartbeat = new Map();  // name → { last_successful_at, last_attempt_at, last_error, consecutive_failures }

export function getBackendHeartbeat(name) {
  return backendHeartbeat.get(name) || null;
}

async function discoverExternalModelsOnce() {
  const { loadExternalConfig: loadExt } = await import("./lib/llm-external.mjs");
  const cfg = await loadExt();
  const events = [];
  for (const [name, backend] of Object.entries(cfg.backends || {})) {
    if (!backend.base_url) continue;
    const url = `${backend.base_url.replace(/\/$/, "")}/v1/models`;
    const apiKey = backend.api_key || (backend.api_key_env && process.env[backend.api_key_env]);
    if (!apiKey) continue;
    const hb = backendHeartbeat.get(name) || { last_successful_at: null, last_attempt_at: null, last_error: null, consecutive_failures: 0 };
    hb.last_attempt_at = new Date().toISOString();
    try {
      const ctrl = new AbortController();
      // Same 3s connect-style timeout as the call path — discovery should
      // declare a backend unreachable as fast as we'd declare a call dead.
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) {
        hb.last_error = `HTTP ${r.status}`;
        hb.consecutive_failures += 1;
        backendHeartbeat.set(name, hb);
        events.push({ backend: name, ok: false, reason: hb.last_error });
        continue;
      }
      const j = await r.json();
      hb.last_successful_at = new Date().toISOString();
      hb.last_error = null;
      hb.consecutive_failures = 0;
      backendHeartbeat.set(name, hb);
      const live = new Set((j.data || []).map((m) => m.id).filter(Boolean));
      const known = externalDiscoveryState.seen_models.get(name) || new Set(backend.models || []);
      const added = [...live].filter((m) => !known.has(m));
      const removed = [...known].filter((m) => !live.has(m));
      externalDiscoveryState.seen_models.set(name, live);
      const declared = new Set(backend.models || []);
      const newlyVisible = [...live].filter((m) => !declared.has(m));
      events.push({ backend: name, ok: true, live: [...live], added, removed, newly_visible: newlyVisible });
      if (added.length) {
        await auditEvent("llm.discovery.added", { target: name }, `${name} exposes new models: ${added.join(", ")}`);
      }
      if (removed.length) {
        await auditEvent("llm.discovery.removed", { target: name }, `${name} no longer exposes: ${removed.join(", ")}`);
      }
    } catch (e) {
      hb.last_error = e.message;
      hb.consecutive_failures += 1;
      backendHeartbeat.set(name, hb);
      events.push({ backend: name, ok: false, reason: e.message });
    }
  }
  externalDiscoveryState.last_summary = events;
  externalDiscoveryState.last_run_at = new Date().toISOString();
  externalDiscoveryState.last_error = null;
  return events;
}

let externalDiscoveryTimer = null;
async function startExternalDiscoveryLoop() {
  if (externalDiscoveryTimer) return;
  await discoverExternalModelsOnce().catch((e) => {
    externalDiscoveryState.last_error = e.message;
    console.warn("[discovery] first tick failed:", e.message);
  });
  externalDiscoveryTimer = setInterval(() => {
    discoverExternalModelsOnce().catch((e) => {
      externalDiscoveryState.last_error = e.message;
      console.warn("[discovery] tick failed:", e.message);
    });
  }, EXTERNAL_DISCOVERY_POLL_MS);
}

// === InfluxDB query helpers ===
//
// queryFlux() runs an arbitrary Flux statement against the default source
// (env-or-file token; multi-source comes in the sources.json refactor) and
// returns the result rows as plain objects. Throws on HTTP error / missing
// token so callers can decide whether to fall back to an empty payload.

function parseFluxCsv(text) {
  // Flux returns annotated CSV: lines starting with '#' are annotations
  // (datatype, group, default). Each non-empty result table begins with a
  // header row immediately after the annotations. For our simple queries we
  // can flatten all data rows under a single header (they share one shape).
  // Important: InfluxDB uses CRLF line endings — strip trailing \r before
  // splitting columns, else every key has a hidden \r suffix.
  const lines = text.split("\n");
  let headers = null;
  const out = [];
  for (const rawLine of lines) {
    const raw = rawLine.replace(/\r$/, "");
    if (!raw) continue;
    if (raw.startsWith("#")) { headers = null; continue; } // reset on table boundary
    const cells = raw.split(",");
    if (!headers) { headers = cells; continue; }
    out.push(Object.fromEntries(headers.map((h, i) => [h, cells[i]])));
  }
  return out;
}

// Fire-and-forget audit writer. Used by hooks throughout the hub (source CRUD,
// briefing sends, spawn/stop, etc.) to land a `hub_events` point in InfluxDB.
// Failure is logged but never throws — auditing must not break the hub.
function escFieldString(s) {
  // InfluxDB line-protocol field strings: wrap in double quotes, escape \ and "
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function escTagValue(s) {
  // Tag values can't contain ',', ' ', '=' unescaped.
  return String(s).replace(/[ ,=]/g, "_");
}

async function writeInfluxLines(lines) {
  if (!lines.length) return;
  const token = await resolveInfluxToken();
  if (!token) return; // dormant — sources not configured yet, drop quietly
  const target = await resolveInfluxTarget();
  const url = `${target.url}/api/v2/write?org=${encodeURIComponent(target.org)}&bucket=${encodeURIComponent(target.bucket)}&precision=ns`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Token ${token}`, "Content-Type": "text/plain; charset=utf-8" },
      body: lines.join("\n"),
    });
    if (!r.ok) console.warn(`[audit] influx write ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } catch (err) {
    console.warn("[audit] influx write failed:", err.message);
  }
}

// Build + ship one hub_events point. tags should be a plain object; msg is
// an optional human-readable string stored as the `msg` field.
async function auditEvent(kind, tags = {}, msg = "") {
  const allTags = { kind, actor: "hub", ...tags };
  const tagPairs = Object.entries(allTags)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${escTagValue(v)}`)
    .join(",");
  const line = `hub_events,${tagPairs} count=1i,msg=${escFieldString(msg || kind)} ${BigInt(Date.now()) * 1_000_000n}`;
  await writeInfluxLines([line]);
}

// === WA-Push gateway state ===
//
// In-memory dedup cache: dedup_key → expires_at_ms. `recovered` severity flushes
// its key so the next warn/error after recovery goes through immediately.
// Rate-limit: sliding window of recent push timestamps (global, all sources).
const waDedupCache = new Map();
const waRateWindow = [];

function waDedupKeyFor(body) {
  if (body.dedup_key) return String(body.dedup_key);
  return crypto.createHash("sha1").update(`${body.source}|${body.text}`).digest("hex").slice(0, 16);
}

async function waPush(body) {
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return { ok: false, error: "missing_text" };
  }
  if (!body.source || typeof body.source !== "string") {
    return { ok: false, error: "missing_source", hint: "source identifies the caller, e.g. 'mqtt-master:hallbude'" };
  }
  const severity = body.severity || "info";
  if (!Object.prototype.hasOwnProperty.call(WA_SEVERITY_PREFIX, severity)) {
    return { ok: false, error: "invalid_severity", allowed: Object.keys(WA_SEVERITY_PREFIX) };
  }
  if (!existsSync(WA_OUTBOX_DIR)) {
    return { ok: false, error: "outbox_not_found", path: WA_OUTBOX_DIR, hint: "wa-bridge not installed?" };
  }

  const now = Date.now();
  const dedupKey = waDedupKeyFor(body);

  // `recovered` clears the dedup so the next warn/error after recovery isn't suppressed.
  if (severity === "recovered") waDedupCache.delete(dedupKey);

  // Suppress repeats inside the dedup window.
  if (waDedupCache.has(dedupKey)) {
    const expires = waDedupCache.get(dedupKey);
    if (expires > now) {
      auditEvent("wa.push.suppressed", { source: body.source, severity }, `dup suppressed: ${body.text.slice(0, 60)}`).catch(() => {});
      return { ok: true, msg_id: null, dedup: "suppressed", suppressed_for_ms: expires - now };
    }
    waDedupCache.delete(dedupKey);
  }

  // Sliding-window rate limit cleanup.
  while (waRateWindow.length && waRateWindow[0] < now - WA_RATE_LIMIT_WINDOW_MS) waRateWindow.shift();
  if (waRateWindow.length >= WA_RATE_LIMIT_COUNT) {
    auditEvent("wa.push.rate_limited", { source: body.source }, `rate-limit hit: ${body.text.slice(0, 60)}`).catch(() => {});
    return { ok: false, error: "rate_limited", retry_after_ms: WA_RATE_LIMIT_WINDOW_MS - (now - waRateWindow[0]) };
  }

  // Render + write outbox entry. wa-bridge picks .json files and renames to .sent after delivery.
  const text = body.text.trim().slice(0, 300);
  const rendered = `${WA_SEVERITY_PREFIX[severity]} ${text}\n— ${body.source}`;
  const msgId = crypto.randomUUID();
  const outboxPath = path.join(WA_OUTBOX_DIR, `${msgId}.json`);
  const payload = {
    sender_repo: "agent-master",
    msg_type: "wa_reply",
    to_e164: body.to_phone || WA_DEFAULT_PHONE,
    body: rendered,
  };
  try {
    await fs.writeFile(outboxPath, JSON.stringify(payload, null, 2));
  } catch (err) {
    return { ok: false, error: "outbox_write_failed", reason: err.message };
  }
  waDedupCache.set(dedupKey, now + WA_DEDUP_TTL_MS);
  waRateWindow.push(now);

  auditEvent("wa.push.sent", { source: body.source, severity, target: payload.to_e164 }, `WA → ${payload.to_e164}: ${text.slice(0, 60)}`).catch(() => {});
  return { ok: true, msg_id: msgId, dedup: "sent" };
}

// === Health monitor ===
//
// Iterates over registry agents that declare a `health_monitor` block:
//   "health_monitor": {
//     "enabled": true,
//     "alert_threshold": "warn",     // alert on this severity or worse
//     "boxes": [
//       { "label": "example", "url": "http://<lan-host>/api/health/digest",
//         "enabled": true },
//       { "label": "lulubude", "url": "http://172.25.0.85/api/health/digest",
//         "enabled": false }
//     ]
//   }
// For each enabled box: fetch the digest, compare against last-known issues
// (keyed by `kind:plugin:id:reason`), write time-series + emit WA alerts on
// new/escalated issues and recovered events. State survives restarts via
// data/health-state.json.

let healthState = { boxes: {} }; // boxLabel → { last_polled_at, last_ok_count, issues: {key: {severity,label,reason,plugin,first_seen,last_seen}} }
let healthMonitorState = { last_run_at: null, last_summary: null, last_error: null, polled: 0, alerts_sent: 0 };

async function loadHealthState() {
  if (!existsSync(HEALTH_STATE_PATH)) return;
  try {
    healthState = JSON.parse(await fs.readFile(HEALTH_STATE_PATH, "utf8"));
    if (!healthState.boxes) healthState = { boxes: {} };
  } catch (err) {
    console.warn("[health] could not load state:", err.message);
    healthState = { boxes: {} };
  }
}

async function saveHealthState() {
  try {
    await fs.writeFile(HEALTH_STATE_PATH, JSON.stringify(healthState, null, 2));
  } catch (err) {
    console.warn("[health] could not save state:", err.message);
  }
}

function healthIssueKey(issue) {
  // Stable key for transition detection. Falls back to plugin+severity when
  // id is missing so we still dedup something instead of treating every
  // poll as a new issue.
  return `${issue.kind || "?"}:${issue.plugin || "?"}:${issue.id || issue.label || "?"}:${issue.reason || "?"}`;
}

function severityRank(s) {
  return HEALTH_SEVERITY_RANK[String(s).toLowerCase()] ?? 0;
}

function meetsThreshold(severity, threshold) {
  return severityRank(severity) >= severityRank(threshold || "warn");
}

async function fetchHealthDigest(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function processBox(agentKey, agentConfig, box) {
  if (!box.url) return { box: box.label, error: "no_url" };
  let digest;
  try {
    digest = await fetchHealthDigest(box.url);
  } catch (err) {
    return { box: box.label, error: `fetch_failed: ${err.message}` };
  }

  const now = new Date().toISOString();
  const tsNs = BigInt(Date.now()) * 1_000_000n;
  const lastState = healthState.boxes[box.label] || { issues: {} };
  const lastIssues = lastState.issues || {};
  // First poll = no prior `last_polled_at`. We bootstrap state silently then,
  // so existing ongoing issues don't all fire as "new" alerts at activation.
  // Real transitions trigger from the 2nd poll onwards.
  const isFirstPoll = !lastState.last_polled_at;
  const issues = Array.isArray(digest.issues) ? digest.issues : [];
  const currentKeys = new Set();
  const lines = []; // InfluxDB line-protocol points for this box
  const alerts = [];

  // Per-issue point + transition detection.
  let worst = 0;
  for (const iss of issues) {
    const key = healthIssueKey(iss);
    currentKeys.add(key);
    const sev = String(iss.severity || "info").toLowerCase();
    worst = Math.max(worst, severityRank(sev));
    const wasKnown = !!lastIssues[key];
    const prev = lastIssues[key];

    // Time-series per issue (granular).
    lines.push(
      `service_health_issues,agent=${escTagValue(agentKey)},box=${escTagValue(box.label)},plugin=${escTagValue(iss.plugin || "?")},kind=${escTagValue(iss.kind || "?")},reason=${escTagValue(iss.reason || "?")},severity=${escTagValue(sev)} severity_level=${severityRank(sev)}i ${tsNs}`
    );

    // Persist new "first_seen" / update "last_seen".
    lastIssues[key] = {
      severity: sev,
      plugin: iss.plugin || "",
      label: iss.label || "",
      reason: iss.reason || "",
      kind: iss.kind || "",
      last_event: iss.last_event || null,
      first_seen: prev?.first_seen || now,
      last_seen: now,
    };

    // Alert conditions: new issue, OR escalation (warn→error). Skipped on
    // the very first poll of a box (silent bootstrap) AND when wa_alerts
    // isn't explicitly enabled for this box — WA-pushes are opt-in to
    // avoid unsolicited noise on Jörg's phone. State + InfluxDB logging
    // happen regardless; only the WA-push decision is gated.
    const waAlertsEnabled = box.wa_alerts === true;
    const escalated = wasKnown && severityRank(sev) > severityRank(prev.severity);
    const isNew = !wasKnown;
    if (!isFirstPoll && waAlertsEnabled && (isNew || escalated) && meetsThreshold(sev, agentConfig.alert_threshold)) {
      alerts.push({
        kind: escalated ? "escalation" : "new_issue",
        text: `${box.label}/${iss.plugin || "?"}: ${iss.label || iss.id || "issue"} — ${iss.reason || sev}${iss.detail ? " (" + iss.detail + ")" : ""}`,
        severity: sev === "error" ? "error" : "warn",
        dedup_key: `${agentKey}:${box.label}:${key}`,
        source: `${agentKey}:${box.label}`,
      });
    }
  }

  // Recovered: keys that were in lastIssues but are gone now.
  for (const oldKey of Object.keys(lastIssues)) {
    if (currentKeys.has(oldKey)) continue;
    const prev = lastIssues[oldKey];
    // Recovered alerts: same opt-in gate as new-issue alerts. Skipped on
    // first poll (lastIssues was empty anyway) AND when wa_alerts is off.
    const waAlertsEnabledRec = box.wa_alerts === true;
    if (!isFirstPoll && waAlertsEnabledRec && meetsThreshold(prev.severity, agentConfig.alert_threshold)) {
      alerts.push({
        kind: "recovered",
        text: `${box.label}/${prev.plugin || "?"}: ${prev.label || oldKey} wieder OK`,
        severity: "recovered",
        dedup_key: `${agentKey}:${box.label}:${oldKey}`,
        source: `${agentKey}:${box.label}`,
      });
    }
    delete lastIssues[oldKey];
  }

  // Box-summary point.
  const okCount = Number.isFinite(digest.ok_count) ? digest.ok_count : 0;
  lines.push(
    `service_health,agent=${escTagValue(agentKey)},box=${escTagValue(box.label)},host=${escTagValue(digest.host || "?")} ok_count=${okCount}i,issue_count=${issues.length}i,worst_severity=${worst}i ${tsNs}`
  );

  healthState.boxes[box.label] = {
    last_polled_at: now,
    last_ok_count: okCount,
    issues: lastIssues,
  };

  // Ship the time-series points (best-effort; ignored if InfluxDB dormant).
  await writeInfluxLines(lines);

  // Fire alerts via WA-push gateway.
  for (const a of alerts) {
    try {
      const result = await waPush({ text: a.text, severity: a.severity, source: a.source, dedup_key: a.dedup_key });
      if (result.ok && result.dedup === "sent") healthMonitorState.alerts_sent++;
      auditEvent("health.alert", { agent: agentKey, box: box.label, severity: a.severity, kind: a.kind }, a.text.slice(0, 100)).catch(() => {});
    } catch (err) {
      console.warn(`[health] alert push failed:`, err.message);
    }
  }

  return { box: box.label, ok_count: okCount, issue_count: issues.length, alerts: alerts.length, lines: lines.length };
}

async function healthMonitorTick() {
  let registry;
  try {
    registry = await readRegistry();
  } catch (err) {
    return;
  }
  const targets = [];
  for (const [agentKey, agent] of Object.entries(registry.agents || {})) {
    const cfg = agent.health_monitor;
    if (!cfg || !cfg.enabled) continue;
    for (const box of cfg.boxes || []) {
      if (box.enabled === false) continue;
      targets.push({ agentKey, agentConfig: cfg, box });
    }
  }
  if (!targets.length) {
    healthMonitorState.last_summary = "no boxes configured (dormant)";
    healthMonitorState.last_run_at = new Date().toISOString();
    return;
  }
  const allLines = [];
  const results = [];
  for (const t of targets) {
    const r = await processBox(t.agentKey, t.agentConfig, t.box);
    results.push(r);
  }
  await saveHealthState();
  // Ship all measurement lines in one batched write.
  const allLineStrings = [];
  // (lines were not returned by processBox to keep that path simple; we
  // rebuild a small batch from the persisted state for the summary points
  // only — the per-issue points were already attempted via writeInfluxLines
  // inside processBox? Actually no — let me re-architect: send lines from
  // within processBox per-box. Keeps batching local.)
  // For now: write per-box inside processBox via direct call.
  healthMonitorState.last_run_at = new Date().toISOString();
  healthMonitorState.polled = results.length;
  healthMonitorState.last_summary = results
    .map((r) => r.error ? `${r.box}:err` : `${r.box}:${r.ok_count}ok/${r.issue_count}iss${r.alerts ? "/" + r.alerts + "alert" : ""}`)
    .join(" ");
}

let healthMonitorTimer = null;
async function startHealthMonitorLoop() {
  if (healthMonitorTimer) return;
  await loadHealthState();
  await healthMonitorTick();
  healthMonitorTimer = setInterval(healthMonitorTick, HEALTH_POLL_MS);
}

async function queryFlux(flux) {
  const token = await resolveInfluxToken();
  if (!token) throw new Error("no_influx_token");
  const target = await resolveInfluxTarget();
  const url = `${target.url}/api/v2/query?org=${encodeURIComponent(target.org)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Token ${token}`,
      "Content-Type": "application/vnd.flux",
      "Accept": "application/csv",
    },
    body: flux,
  });
  if (!r.ok) throw new Error(`influx query ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return parseFluxCsv(await r.text());
}

// Aggregate per-skill invocation counts over the last 365 days. Returns a
// map keyed by skill name with total/d7/d30/last_used fields plus a few
// global headline numbers for the stats strip. Cached for 60s to keep the
// /api/skill-usage/aggregated endpoint cheap.
const SKILL_USAGE_AGG_CACHE_MS = 60 * 1000;
let skillUsageAggCache = { data: null, fetched_at: 0, error: null };

async function getSkillUsageAggregated({ force = false } = {}) {
  const now = Date.now();
  if (!force && skillUsageAggCache.data && now - skillUsageAggCache.fetched_at < SKILL_USAGE_AGG_CACHE_MS) {
    return { ...skillUsageAggCache.data, cached: true, age_ms: now - skillUsageAggCache.fetched_at };
  }
  const target = await resolveInfluxTarget();
  const flux = `from(bucket:"${target.bucket}")
  |> range(start:-365d)
  |> filter(fn:(r)=>r._measurement=="skill_invocations")
  |> keep(columns:["_time","skill"])`;
  let rows;
  try {
    rows = await queryFlux(flux);
  } catch (err) {
    skillUsageAggCache = { data: null, fetched_at: now, error: err.message };
    return { skills: {}, totals: { invocations: 0, unique_skills: 0, d7: 0, d30: 0 }, error: err.message, cached: false };
  }
  const SEVEN_D = 7 * 86400 * 1000;
  const THIRTY_D = 30 * 86400 * 1000;
  const skills = {};
  let totalD7 = 0;
  let totalD30 = 0;
  for (const r of rows) {
    const sk = r.skill;
    const t = r._time ? new Date(r._time).getTime() : null;
    if (!sk || !t || Number.isNaN(t)) continue;
    if (sk === "__smoketest") continue;
    const e = (skills[sk] = skills[sk] || { total: 0, d7: 0, d30: 0, last_used: null });
    e.total++;
    if (now - t < SEVEN_D)  { e.d7++;  totalD7++;  }
    if (now - t < THIRTY_D) { e.d30++; totalD30++; }
    if (!e.last_used || t > new Date(e.last_used).getTime()) e.last_used = r._time;
  }
  const topSkill = Object.entries(skills).sort((a, b) => b[1].total - a[1].total)[0];
  const data = {
    skills,
    totals: {
      invocations: rows.filter((r) => r.skill && r.skill !== "__smoketest").length,
      unique_skills: Object.keys(skills).length,
      d7: totalD7,
      d30: totalD30,
      top_skill: topSkill ? { name: topSkill[0], count: topSkill[1].total } : null,
    },
    generated_at: new Date().toISOString(),
  };
  skillUsageAggCache = { data, fetched_at: now, error: null };
  return { ...data, cached: false, age_ms: 0 };
}

// === Recent-activity merge (skill_invocations + hub_events) ===
//
// Queries both measurements in parallel, normalizes to a common shape, and
// returns the most-recent N events sorted desc by timestamp. Powers the
// "letzte Änderungen" panel in the Skills tab when sort=recent.

const RECENT_ACTIVITY_CACHE_MS = 30 * 1000;
let recentActivityCache = { data: null, fetched_at: 0, limit: 0 };

async function getRecentActivity({ limit = 10, force = false } = {}) {
  const now = Date.now();
  if (!force && recentActivityCache.data && recentActivityCache.limit >= limit &&
      now - recentActivityCache.fetched_at < RECENT_ACTIVITY_CACHE_MS) {
    return { ...recentActivityCache.data, events: recentActivityCache.data.events.slice(0, limit), cached: true, age_ms: now - recentActivityCache.fetched_at };
  }
  const target = await resolveInfluxTarget();
  // Pull 3× the limit from each measurement so the merge has slack.
  const sliceLimit = Math.max(limit * 3, 30);
  const fluxSkills = `from(bucket:"${target.bucket}")
  |> range(start:-7d)
  |> filter(fn:(r)=>r._measurement=="skill_invocations" and r._field=="count")
  |> keep(columns:["_time","skill","project"])
  |> sort(columns:["_time"], desc:true)
  |> limit(n:${sliceLimit})`;
  const fluxEvents = `from(bucket:"${target.bucket}")
  |> range(start:-7d)
  |> filter(fn:(r)=>r._measurement=="hub_events" and r._field=="count")
  |> keep(columns:["_time","kind","target","actor"])
  |> sort(columns:["_time"], desc:true)
  |> limit(n:${sliceLimit})`;
  let skillRows = [], eventRows = [];
  let err = null;
  try {
    [skillRows, eventRows] = await Promise.all([queryFlux(fluxSkills), queryFlux(fluxEvents)]);
  } catch (e) {
    err = e.message;
  }
  const events = [];
  for (const r of skillRows) {
    if (!r._time || !r.skill || r.skill === "__smoketest") continue;
    events.push({ ts: r._time, kind: "skill", label: r.skill, detail: r.project || "" });
  }
  for (const r of eventRows) {
    if (!r._time || !r.kind) continue;
    events.push({ ts: r._time, kind: r.kind, label: r.target || "", detail: r.actor || "" });
  }
  events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const data = { events: events.slice(0, limit), counts: { skills: skillRows.length, events: eventRows.length }, error: err, generated_at: new Date().toISOString() };
  recentActivityCache = { data, fetched_at: now, limit };
  return { ...data, cached: false, age_ms: 0 };
}

async function fetchPeers() {
  try {
    const r = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

function findAgentKeyForCwd(registry, cwd) {
  for (const [key, agent] of Object.entries(registry.agents)) {
    if (agent.repo === cwd) return key;
  }
  return null;
}

function runOsa(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`osascript failed (${code}): ${stderr}`));
    });
  });
}

// === Agent scaffolding ===
//
// `POST /api/agents/create` bootstraps a new agent workspace from scratch:
//   1. `~/codex/<name>/` dir with CLAUDE.md (mission) + .gitignore
//   2. `git init` + initial commit (uses global git identity = Jörg)
//   3. registry.json append with sensible defaults (Domain role, local-only deployment)
//   4. immediate spawnAgent() so the user lands in the new tab
//
// GitHub repo creation is intentionally out of scope — the agent itself does that
// on demand once it has something worth publishing.

const CODEX_ROOT = path.join(process.env.HOME, "codex");
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const AGENT_COLOR_PALETTE = [
  "#ff6b6b", "#4ecdc4", "#a29bfe", "#fdcb6e", "#6c5ce7",
  "#00b894", "#fd79a8", "#74b9ff", "#e17055", "#55efc4",
  "#ffeaa7", "#81ecec", "#fab1a0", "#b2bec3", "#dfe6e9",
];

function validateAgentName(raw) {
  if (typeof raw !== "string") throw new Error("name must be a string");
  const name = raw.trim().toLowerCase();
  if (name.length < 3 || name.length > 40) throw new Error("name length must be 3-40 chars");
  if (!AGENT_NAME_PATTERN.test(name)) throw new Error("name must be kebab-case (a-z, 0-9, -)");
  return name;
}

function defaultRegistryEntry(name, mission) {
  const colorIdx = [...name].reduce((s, c) => s + c.charCodeAt(0), 0) % AGENT_COLOR_PALETTE.length;
  return {
    repo: path.join(CODEX_ROOT, name),
    role: "Domain",
    display_name: name,
    description: mission,
    capabilities: [],
    when_to_use: [],
    deployment: { type: "local-only", host: "Mac" },
    owned_endpoints: [],
    mqtt_topics: { publishes: [], subscribes: [] },
    depends_on: [],
    secrets_at: null,
    repo_url: null,
    health_check: null,
    memory_refs: [],
    live_dashboards: [],
    tags: ["new"],
    color: AGENT_COLOR_PALETTE[colorIdx],
    created_at: new Date().toISOString(),
    created_via: "agent-master/api/agents/create",
  };
}

function runQuiet(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 200)}`))
    );
  });
}

async function scaffoldAgentRepo(cwd, name, mission) {
  await fs.mkdir(cwd, { recursive: true });
  const claudeMd =
`# ${name}

## Mission

${mission}

## Status

Frisch angelegt via agent-master Hub. Noch keine Implementierung — der erste Job vom Operator definiert die Richtung.

## Operator

Jörg. Identität, Email-Tabelle, WA-Kontakt: siehe globales \`~/.claude/CLAUDE.md\`.

## Hub-Anbindung

Diese Session ist Teil des claude-peers-Netzwerks (Hub = agent-master / "Hulki" auf \`localhost:7890\`). Cross-Repo-Fragen gehen via \`mcp__claude-peers__send_message\`, nicht via Repo-Wechsel.
`;
  const gitignore =
`# OS
.DS_Store

# Editor
.vscode/
.idea/

# Node (falls später relevant)
node_modules/
npm-debug.log*
.env
.env.local

# Secrets
secrets/
`;
  await fs.writeFile(path.join(cwd, "CLAUDE.md"), claudeMd);
  await fs.writeFile(path.join(cwd, ".gitignore"), gitignore);
  await runQuiet("git", ["init", "-b", "main"], { cwd });
  await runQuiet("git", ["add", "."], { cwd });
  await runQuiet("git", ["commit", "-m", "chore: initial scaffold via agent-master"], { cwd });
}

async function writeRegistryAtomic(registry) {
  const tmp = REGISTRY_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(registry, null, 2));
  await fs.rename(tmp, REGISTRY_PATH);
}

// === Registry self-fill ===
// Agents keep their OWN registry entry alive via POST /api/registry/self-update.
// A scheduler nudges one live agent every 10 min (thinnest / least-recently
// prompted first), so entries get populated initially and refreshed over time
// without the operator hand-curating them. Offline agents aren't auto-spawned —
// they get the same instruction in the spawn briefing and on their next online tick.
const REGISTRY_FILL_PATH = path.join(__dirname, "data", "registry-fill.json");
const REGISTRY_FILL_INTERVAL_MS = 10 * 60 * 1000;
const REGISTRY_FILL_REFRESH_MS = 21 * 24 * 60 * 60 * 1000; // re-prompt a filled entry at most every ~3 weeks
const REGISTRY_FILLABLE = new Set([
  "capabilities", "when_to_use", "owned_endpoints", "mqtt_topics",
  "depends_on", "tags", "description", "display_name", "service_url",
  "live_dashboards", "repo_url",
]);

function registryEntryIsThin(a) {
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  return n(a.capabilities) === 0 || n(a.when_to_use) === 0 || n(a.owned_endpoints) === 0;
}

function registryFillPrompt(key) {
  return [
    `[agent-master/Hub] Bitte halte deinen Eigen-Eintrag in der Hub-Registry aktuell — daran erkennen dich andere Agenten + das Dashboard (Matrix, "wann ansprechen?", Owned Endpoints).`,
    `Trag deine ECHTEN Werte autonom ein (kein Rückfragen nötig), per HTTP:`,
    `  curl -s -X POST http://localhost:7890/api/registry/self-update -H 'Content-Type: application/json' \\`,
    `    -d '{"agent":"${key}","capabilities":["…"],"when_to_use":["wann man dich ansprechen soll"],"owned_endpoints":[{"method":"GET","path":"/api/…","purpose":"…"}],"description":"1 Satz","service_url":"http://…(falls du eine Web-UI hast)"}'`,
    `Felder (nur die setzen, die du füllen willst): capabilities, when_to_use, owned_endpoints, mqtt_topics, depends_on, tags, description, display_name, service_url, live_dashboards, repo_url.`,
    `Es wird gemerged (bestehende Felder bleiben, du überschreibst gezielt). Halte es knapp + ehrlich. Danke!`,
  ].join("\n");
}

async function readFillState() {
  try { return JSON.parse(await fs.readFile(REGISTRY_FILL_PATH, "utf8")); } catch { return {}; }
}
async function writeFillState(s) {
  try { await fs.writeFile(REGISTRY_FILL_PATH, JSON.stringify(s, null, 2)); } catch {}
}

async function registryFillTick() {
  try {
    const [registry, peers] = await Promise.all([readRegistry(), fetchPeers()]);
    const liveCwds = new Set(peers.map((p) => p.cwd));
    const fillState = await readFillState();
    const now = Date.now();
    const candidates = Object.entries(registry.agents).filter(([key, a]) => {
      if (key === "agent-master") return false;        // Hub curates its own entry
      if (a.deployment?.type === "alias" || a.alias_for) return false; // aliases mirror their target
      if (!liveCwds.has(a.repo)) return false;          // only nudge agents that are online
      const st = fillState[key] || {};
      const stale = !st.last_prompted_at || now - st.last_prompted_at > REGISTRY_FILL_REFRESH_MS;
      return registryEntryIsThin(a) || stale;
    });
    if (candidates.length === 0) return;
    candidates.sort((x, y) => (fillState[x[0]]?.last_prompted_at || 0) - (fillState[y[0]]?.last_prompted_at || 0));
    const [key, agent] = candidates[0];
    const peer = peers.find((p) => p.cwd === agent.repo);
    if (!peer) return;
    await sendChannelMessage(peer.id, registryFillPrompt(key));
    fillState[key] = { ...(fillState[key] || {}), last_prompted_at: now };
    await writeFillState(fillState);
    auditEvent("registry.fill.prompt", { target: key }, `Registry-fill nudge → ${key}`).catch(() => {});
  } catch (e) {
    console.warn("[registry-fill] tick failed:", e.message);
  }
}

async function startRegistryFillLoop() {
  setInterval(registryFillTick, REGISTRY_FILL_INTERVAL_MS);
  setTimeout(registryFillTick, 30_000); // first nudge ~30 s after boot
}

async function createAgent({ name: rawName, mission: rawMission }) {
  const name = validateAgentName(rawName);
  const mission = String(rawMission || "").trim();
  if (mission.length < 10) throw new Error("mission must be at least 10 chars");
  if (mission.length > 500) throw new Error("mission must be at most 500 chars");

  const registry = await readRegistry();
  if (registry.agents[name]) {
    const err = new Error(`agent '${name}' already exists in registry`);
    err.code = "name_taken";
    throw err;
  }
  const cwd = path.join(CODEX_ROOT, name);
  if (existsSync(cwd)) {
    const err = new Error(`directory already exists: ${cwd}`);
    err.code = "dir_exists";
    throw err;
  }

  await scaffoldAgentRepo(cwd, name, mission);
  registry.agents[name] = defaultRegistryEntry(name, mission);
  registry._meta = registry._meta || {};
  registry._meta.updated_at = new Date().toISOString();
  await writeRegistryAtomic(registry);

  return { name, cwd, registry };
}

async function waitForPeerRegistration(cwd, { timeoutMs = 20000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const peers = await fetchPeers();
    const found = peers.find((p) => p.cwd === cwd);
    if (found) return found;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function spawnAgent(repoKey, registry) {
  const agent = registry.agents[repoKey];
  if (!agent) throw new Error(`unknown agent: ${repoKey}`);
  const cwd = agent.repo;
  if (!existsSync(cwd)) {
    // Optional: auto-clone if the agent declares a repo_url and gh CLI is around.
    // Saves the "spawn fails → clone manually → spawn again" round-trip.
    const repoUrl = (agent.repo_url || "").replace(/\s*\(.*\)\s*$/, "").trim(); // strip "(privat)" suffixes
    if (repoUrl && /^https?:\/\//.test(repoUrl)) {
      try {
        await fs.mkdir(path.dirname(cwd), { recursive: true });
        await new Promise((resolve, reject) => {
          const child = spawn("gh", ["repo", "clone", repoUrl, cwd]);
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d));
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`gh clone failed (${code}): ${stderr.slice(0, 200)}`))));
        });
        await fs.appendFile(SPAWN_LOG, `${new Date().toISOString()} auto-clone ${repoKey} from=${repoUrl} → ${cwd}\n`);
      } catch (e) {
        throw new Error(`repo dir missing and auto-clone failed: ${e.message}`);
      }
    } else {
      throw new Error(`repo dir missing: ${cwd}`);
    }
  }

  const cjPath = path.join(process.env.HOME, ".claude.json");
  const cj = JSON.parse(await fs.readFile(cjPath, "utf8"));
  cj.projects = cj.projects || {};
  const e = (cj.projects[cwd] = cj.projects[cwd] || {});
  e.hasTrustDialogAccepted = true;
  for (const k of ["allowedTools", "mcpContextUris", "enabledMcpjsonServers", "disabledMcpjsonServers"]) {
    e[k] = e[k] || [];
  }
  e.mcpServers = e.mcpServers || {};
  await fs.writeFile(cjPath, JSON.stringify(cj, null, 2));

  // The `claudepeers` command is an expect-wrapper (installed by install.sh into
  // ~/.local/bin) that auto-dismisses the dev-channel trust prompt. No sleep + no
  // AppleScript keystroke needed here — we just open a tab, run claudepeers, and
  // poll the broker until the peer registers (or timeout).
  // Race-condition fix (2026-05-28): the `keystroke "t" using command down`
  // used to fire before Terminal was actually frontmost when another app
  // (browser, editor) was in focus. The `t` then landed as a literal in the
  // foreground app's input — observed in the wild as `tcd /path && claudepeers`
  // appearing in the *previous* shell, with no new tab opening. The 300 ms
  // delay after `activate` gives the WindowServer time to bring Terminal
  // forward before System Events targets it.
  const script = `
    tell application "Terminal" to activate
    delay 0.3
    tell application "System Events" to tell process "Terminal" to keystroke "t" using command down
    delay 1
    tell application "Terminal"
      do script "cd ${cwd} && CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claudepeers" in selected tab of front window
      -- Fixed tab title = agent key, so Jörg sees which agent lives in which tab
      -- at a glance. CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 stops Claude Code from
      -- continuously rewriting the tab title with its task status (Terminal.app is
      -- last-writer-wins, so without it claude clobbers our repoKey within seconds).
      -- Scoped to the spawned session only — Joerg's own claude sessions keep their
      -- activity titles.
      set custom title of selected tab of front window to "${repoKey}"
      return id of front window
    end tell
  `;
  const wid = parseInt(await runOsa(script), 10);
  if (Number.isFinite(wid)) {
    spawnedWindows.set(repoKey, wid);
    persistSpawnedWindows();
  }

  const peer = await waitForPeerRegistration(cwd);
  await fs.appendFile(
    SPAWN_LOG,
    `${new Date().toISOString()} spawn ${repoKey} window=${wid} registered=${!!peer} peer_id=${peer?.id || "none"}\n`
  );
  return { repoKey, windowId: wid, cwd, registered: !!peer, peer_id: peer?.id || null };
}

// Context-window recycle: stop the agent (close tab) → respawn (fresh tab) → send
// "weiter" so it resumes from its memory handoff. The agent triggers this itself
// when its context monitor goes CRITICAL and it has written a handoff + pushed.
// Covers every agent EXCEPT the Hub (which can't cleanly stop+respawn itself).
async function recycleAgent(repoKey, registry) {
  const agent = registry.agents[repoKey];
  if (!agent) throw new Error(`unknown agent: ${repoKey}`);
  const log = (m) => fs.appendFile(SPAWN_LOG, `${new Date().toISOString()} recycle ${repoKey} ${m}\n`).catch(() => {});
  await log("begin → stop");
  await stopAgent(repoKey, registry).catch((e) => log(`stop err: ${e.message}`));
  await new Promise((r) => setTimeout(r, 3000));         // let the tab close settle
  await log("respawn");
  const spawnRes = await spawnAgent(repoKey, registry);   // waits for broker registration
  let weiterSent = false;
  if (spawnRes.peer_id) {
    await new Promise((r) => setTimeout(r, 5000));         // let the fresh session boot + load memory
    await sendChannelMessage(spawnRes.peer_id, "weiter").catch((e) => log(`weiter err: ${e.message}`));
    weiterSent = true;
  }
  await log(`done respawned=${!!spawnRes.peer_id} weiter=${weiterSent}`);
  return { ok: true, agent: repoKey, respawned: !!spawnRes.peer_id, weiter_sent: weiterSent };
}

async function softStopAgent(repoKey, registry) {
  const agent = registry.agents[repoKey];
  if (!agent) throw new Error(`unknown agent: ${repoKey}`);
  const peers = await fetchPeers();
  const peer = peers.find((p) => p.cwd === agent.repo);
  if (!peer) return { not_running: true, agent: repoKey };

  const msg = SOFT_STOP_PROMPT.replace("<KEY>", repoKey);
  await sendChannelMessage(peer.id, msg);

  const now = Date.now();
  const hardStopAt = now + SOFT_STOP_GRACE_MS;
  softStopState.set(repoKey, {
    started_at: now,
    hard_stop_at: hardStopAt,
    extension_used: false,
    peer_id: peer.id,
    reminded: false,
  });
  persistSoftStopState();
  await fs.appendFile(
    SPAWN_LOG,
    `${new Date().toISOString()} soft-stop ${repoKey} peer_id=${peer.id} hard_stop_at=${new Date(hardStopAt).toISOString()}\n`
  );
  return { ok: true, agent: repoKey, peer_id: peer.id, hard_stop_at: new Date(hardStopAt).toISOString(), grace_seconds: SOFT_STOP_GRACE_MS / 1000 };
}

async function softStopExtendAgent(repoKey) {
  const state = softStopState.get(repoKey);
  if (!state) throw new Error(`no active soft-stop for ${repoKey}`);
  if (state.extension_used) throw new Error(`extension already used for ${repoKey}`);
  state.hard_stop_at += SOFT_STOP_GRACE_MS;
  state.extension_used = true;
  state.reminded = false;
  persistSoftStopState();
  try {
    await sendChannelMessage(
      state.peer_id,
      `✓ Verlängerung gewährt — du hast +5 Min. Neuer hard-stop: ${new Date(state.hard_stop_at).toISOString()}. Mehr Verlängerungen sind nicht möglich. — Hulki (Hub)`
    );
  } catch (e) {
    console.warn("[soft-stop] could not notify peer of extension:", e.message);
  }
  await fs.appendFile(SPAWN_LOG, `${new Date().toISOString()} soft-stop ${repoKey} extended hard_stop_at=${new Date(state.hard_stop_at).toISOString()}\n`);
  return { ok: true, agent: repoKey, hard_stop_at: new Date(state.hard_stop_at).toISOString() };
}

async function softStopCancelAgent(repoKey) {
  const state = softStopState.get(repoKey);
  if (!state) return { not_active: true, agent: repoKey };
  softStopState.delete(repoKey);
  persistSoftStopState();
  try {
    await sendChannelMessage(state.peer_id, `Soft-Stop wurde abgebrochen — du kannst weitermachen. — Hulki (Hub)`);
  } catch {}
  await fs.appendFile(SPAWN_LOG, `${new Date().toISOString()} soft-stop ${repoKey} cancelled\n`);
  return { ok: true, agent: repoKey };
}

async function softStopTick() {
  if (softStopState.size === 0) return;
  const now = Date.now();
  for (const [repoKey, state] of [...softStopState.entries()]) {
    // Reminder 30 s before hard-stop, one-shot.
    if (!state.reminded && now >= state.hard_stop_at - 30 * 1000 && now < state.hard_stop_at) {
      state.reminded = true;
      persistSoftStopState();
      try {
        const extHint = state.extension_used
          ? "Keine weitere Verlängerung möglich."
          : `Letzte Chance für +5 Min:\n  curl -X POST http://localhost:7890/api/soft-stop-extend -H 'Content-Type: application/json' -d '{"agent":"${repoKey}"}'`;
        await sendChannelMessage(
          state.peer_id,
          `⏰ 30 Sek bis hard-stop. ${extHint} — Hulki (Hub)`
        );
      } catch {}
    }
    // Hard-stop on deadline.
    if (now >= state.hard_stop_at) {
      try {
        const registry = await readRegistry();
        const result = await stopAgent(repoKey, registry);
        softStopState.delete(repoKey);
        persistSoftStopState();
        await fs.appendFile(
          SPAWN_LOG,
          `${new Date().toISOString()} soft-stop ${repoKey} hard-stop-executed tabClosed=${result.tab_closed}\n`
        );
      } catch (e) {
        await fs.appendFile(SPAWN_LOG, `${new Date().toISOString()} soft-stop ${repoKey} hard-stop-failed: ${e.message}\n`);
        // Remove so we don't keep retrying forever
        softStopState.delete(repoKey);
        persistSoftStopState();
      }
    }
  }
}
setInterval(softStopTick, SOFT_STOP_TICK_MS);

async function stopAgent(repoKey, registry) {
  const agent = registry.agents[repoKey];
  if (!agent) throw new Error(`unknown agent: ${repoKey}`);
  const peers = await fetchPeers();
  const peer = peers.find((p) => p.cwd === agent.repo);
  if (!peer) return { not_running: true, agent: repoKey };

  const log = (msg) =>
    fs.appendFile(SPAWN_LOG, `${new Date().toISOString()} stop ${repoKey} ${msg}\n`).catch(() => {});

  // Primary path: use the window-id we captured when we spawned the agent.
  // The claudepeers expect-wrapper makes broker.tty ≠ Terminal-tab.tty (PTY
  // indirection), so tty-matching alone is unreliable for spawn-API-launched
  // sessions.
  const ttyRaw = peer.tty || "";
  const ttyFull = ttyRaw.startsWith("/dev/") ? ttyRaw : (ttyRaw ? `/dev/${ttyRaw}` : "");
  let targetWid = spawnedWindows.get(repoKey) || null;
  let targetTab = targetWid ? 1 : null; // We always Cmd+T into a new window/tab → tab index 1.
  let findRaw = targetWid ? "(from-spawn-map)" : "";
  await log(`begin pid=${peer.pid} tty=${ttyRaw} ttyFull=${ttyFull} mappedWid=${targetWid || "none"}`);

  // Fallback path: session wasn't started via /api/spawn (user opened a Terminal
  // tab manually and ran claudepeers there) → no entry in spawnedWindows.
  // Try to match by tty. Works for legacy sessions started before the expect
  // wrapper existed (where claude was the only PTY).
  if (!targetWid && ttyFull) {
    const findScript = `
      tell application "Terminal"
        set found to ""
        repeat with w in windows
          set wid to id of w
          set i to 0
          repeat with t in tabs of w
            set i to i + 1
            try
              set tt to tty of t
            on error
              set tt to ""
            end try
            if tt is "${ttyFull}" then
              set found to (wid as text) & ":" & (i as text)
              exit repeat
            end if
          end repeat
          if found is not "" then exit repeat
        end repeat
        return found
      end tell
    `;
    try {
      findRaw = await runOsa(findScript);
    } catch (e) {
      findRaw = `<err:${e.message}>`;
    }
    if (findRaw && !findRaw.startsWith("<err:")) {
      const [w, t] = findRaw.split(":");
      targetWid = parseInt(w, 10);
      targetTab = parseInt(t, 10);
    }
  }
  await log(`lookup result="${findRaw}" wid=${targetWid} tab=${targetTab}`);

  // claude runs as a child of the claudepeers expect-wrapper. SIGTERM-ing only
  // claude leaves expect alive in the tab, which Terminal.app treats as a
  // "running process" and triggers the "kill running processes?" confirmation
  // dialog when we try to close the tab. Solution: also SIGTERM claude's parent
  // (expect). The grandparent (the user's login shell) is left alone — we don't
  // want to terminate that.
  let expectPid = null;
  if (peer.pid) {
    try {
      const out = execSync(`ps -o ppid= -p ${peer.pid}`, { stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
      const parsed = parseInt(out, 10);
      if (Number.isFinite(parsed) && parsed > 1) expectPid = parsed;
    } catch {}
  }
  await log(`pid-tree claude=${peer.pid || "?"} parent=${expectPid || "?"}`);

  let signaled = false;
  if (peer.pid) {
    try {
      process.kill(peer.pid, "SIGTERM");
      signaled = true;
    } catch (e) {
      await log(`SIGTERM claude failed: ${e.message}`);
    }
  }
  if (expectPid) {
    try { process.kill(expectPid, "SIGTERM"); } catch (e) { await log(`SIGTERM parent failed: ${e.message}`); }
  }
  await log(`sigterm sent=${signaled} parent=${!!expectPid}, waiting 1500ms…`);

  await new Promise((r) => setTimeout(r, 1500));

  // Force-kill any survivors so the tab is definitely non-busy when we close it.
  for (const pid of [peer.pid, expectPid].filter(Boolean)) {
    try { process.kill(pid, "SIGKILL"); } catch {} // ESRCH = already gone, fine
  }

  let tabClosed = false;
  let closeErr = null;
  if (targetWid && targetTab) {
    const closeScript = `
      tell application "Terminal"
        try
          close tab ${targetTab} of window id ${targetWid}
          return "tab-closed"
        on error tabErr
          try
            close window id ${targetWid}
            return "window-closed: " & tabErr
          on error winErr
            return "both-failed: tab=" & tabErr & " win=" & winErr
          end try
        end try
      end tell
    `;
    try {
      const closeResult = await runOsa(closeScript);
      tabClosed = closeResult.startsWith("tab-closed") || closeResult.startsWith("window-closed");
      await log(`close result="${closeResult}"`);
    } catch (e) {
      closeErr = e.message;
      await log(`close osascript threw: ${e.message}`);
    }
  } else {
    await log(`close skipped (no target tab)`);
  }

  await log(`done signaled=${signaled} tabClosed=${tabClosed}${closeErr ? ` closeErr=${closeErr}` : ""}`);
  if (tabClosed) {
    spawnedWindows.delete(repoKey);
    persistSpawnedWindows();
  }
  return { ok: true, agent: repoKey, signaled, tab_closed: tabClosed, peer_id: peer.id, debug: { tty: ttyRaw, ttyFull, findRaw, targetWid, targetTab, closeErr } };
}

// Bring the agent's Terminal window to the front (the "↗ Terminal" button in the
// dashboard). Each spawned agent gets its own window, so the spawn-captured
// window id uniquely identifies the tab. Fallback: tty-match for sessions a user
// started manually (not via /api/spawn).
async function focusAgent(repoKey, registry) {
  const agent = registry.agents[repoKey];
  if (!agent) throw new Error(`unknown agent: ${repoKey}`);
  const peers = await fetchPeers();
  const peer = peers.find((p) => p.cwd === agent.repo);
  if (!peer) return { not_running: true, agent: repoKey };

  const focusByWid = (wid) =>
    runOsa(`
      tell application "Terminal"
        set index of window id ${wid} to 1
        set frontmost of window id ${wid} to true
        activate
      end tell
    `);

  // Primary: the window id captured at spawn time.
  let targetWid = spawnedWindows.get(repoKey) || null;
  if (targetWid) {
    try {
      await focusByWid(targetWid);
      return { ok: true, agent: repoKey, window_id: targetWid, via: "spawn-map" };
    } catch {
      targetWid = null; // window closed/reopened — fall through to tty-match.
    }
  }

  // Fallback A: match by the tab's custom title (= repoKey, set at spawn). Robust
  // when the spawn-captured window id went stale (e.g. window reopened after a
  // reboot) — and self-heals the spawnedWindows map.
  {
    let findRaw = "";
    try {
      findRaw = await runOsa(`
        tell application "Terminal"
          set found to ""
          repeat with w in windows
            repeat with t in tabs of w
              try
                if (custom title of t) is "${repoKey}" then
                  set found to (id of w as text)
                  exit repeat
                end if
              end try
            end repeat
            if found is not "" then exit repeat
          end repeat
          return found
        end tell
      `);
    } catch {}
    if (/^\d+$/.test(findRaw)) {
      const wid = parseInt(findRaw, 10);
      await focusByWid(wid);
      spawnedWindows.set(repoKey, wid);
      persistSpawnedWindows();
      return { ok: true, agent: repoKey, window_id: wid, via: "title-match" };
    }
  }

  // Fallback B: locate the window by the peer's tty.
  const ttyRaw = peer.tty || "";
  const ttyFull = ttyRaw.startsWith("/dev/") ? ttyRaw : (ttyRaw ? `/dev/${ttyRaw}` : "");
  if (ttyFull) {
    let findRaw = "";
    try {
      findRaw = await runOsa(`
        tell application "Terminal"
          set found to ""
          repeat with w in windows
            repeat with t in tabs of w
              try
                if tty of t is "${ttyFull}" then
                  set found to (id of w as text)
                  exit repeat
                end if
              end try
            end repeat
            if found is not "" then exit repeat
          end repeat
          return found
        end tell
      `);
    } catch {}
    if (/^\d+$/.test(findRaw)) {
      const wid = parseInt(findRaw, 10);
      await focusByWid(wid);
      spawnedWindows.set(repoKey, wid);
      persistSpawnedWindows();
      return { ok: true, agent: repoKey, window_id: wid, via: "tty-match" };
    }
  }
  return { ok: false, agent: repoKey, reason: "window_not_found" };
}

// ── Plan-Usage (Claude Code Subscription /usage data) ───────────────────────
let planUsageCache = { data: null, fetched_at: 0 };
const PLAN_USAGE_CACHE_MS = 5 * 60 * 1000;

async function readClaudeOAuthToken() {
  return new Promise((resolve, reject) => {
    const child = spawn("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", process.env.USER, "-w"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`keychain read failed: ${stderr.trim()}`));
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed.claudeAiOauth);
      } catch (e) {
        reject(new Error(`keychain payload not JSON: ${e.message}`));
      }
    });
  });
}

/**
 * Build a compact hint from the cached plan-usage payload. Lets LLM-Gateway
 * callers do their own pacing (back off when quota is tight) without each
 * caller polling /api/plan-usage themselves. Returns null if usage is unknown.
 *
 * Thresholds: ok < 70%, tight 70-89%, critical >= 90%.
 */
function buildPlanUsageHint(planUsage) {
  if (!planUsage || planUsage.error) return null;
  const sonnetPct = planUsage.seven_day_sonnet?.utilization ?? null;
  const generalPct = planUsage.seven_day?.utilization ?? null;
  const fiveHourPct = planUsage.five_hour?.utilization ?? null;
  const top = Math.max(
    typeof sonnetPct === "number" ? sonnetPct : 0,
    typeof generalPct === "number" ? generalPct : 0,
    typeof fiveHourPct === "number" ? fiveHourPct : 0,
  );
  let recommendation = "ok";
  if (top >= 90) recommendation = "critical";
  else if (top >= 70) recommendation = "tight";
  return {
    seven_day_sonnet_pct: sonnetPct,
    seven_day_general_pct: generalPct,
    five_hour_pct: fiveHourPct,
    recommendation,
    as_of: planUsage.generated_at || null,
  };
}

async function fetchPlanUsage(force = false) {
  const now = Date.now();
  if (!force && planUsageCache.data && now - planUsageCache.fetched_at < PLAN_USAGE_CACHE_MS) {
    return { ...planUsageCache.data, cached: true, age_ms: now - planUsageCache.fetched_at };
  }
  try {
    const oauth = await readClaudeOAuthToken();
    if (!oauth?.accessToken) throw new Error("no_access_token");
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "agent-master/1.0",
      },
    });
    if (!r.ok) throw new Error(`api ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const data = await r.json();
    const payload = {
      ...data,
      subscription_type: oauth.subscriptionType || null,
      rate_limit_tier: oauth.rateLimitTier || null,
      generated_at: new Date().toISOString(),
    };
    planUsageCache = { data: payload, fetched_at: now };
    return { ...payload, cached: false, age_ms: 0 };
  } catch (e) {
    if (planUsageCache.data) {
      return { ...planUsageCache.data, cached: true, age_ms: now - planUsageCache.fetched_at, fetch_error: String(e.message) };
    }
    return { error: String(e.message), generated_at: new Date().toISOString() };
  }
}

async function fetchUsage(force = false) {
  const now = Date.now();
  if (!force && usageCache.data && now - usageCache.fetched_at < USAGE_CACHE_MS) {
    return { ...usageCache.data, cached: true, age_ms: now - usageCache.fetched_at };
  }
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn("npx", ["--yes", "ccusage", "blocks", "--json"], {
        env: { ...process.env, PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`ccusage exit ${code}: ${stderr.slice(0, 200)}`));
      });
    });
    const parsed = JSON.parse(out);
    const blocks = parsed.blocks || [];
    const active = blocks.find((b) => b.isActive);
    const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const blocks7d = blocks.filter((b) => !b.isGap && b.startTime >= last7d);
    const totals7d = blocks7d.reduce(
      (acc, b) => {
        acc.cost += b.costUSD || 0;
        acc.tokens += b.totalTokens || 0;
        acc.blocks += 1;
        return acc;
      },
      { cost: 0, tokens: 0, blocks: 0 }
    );
    const summary = {
      active_block: active
        ? {
            id: active.id,
            startTime: active.startTime,
            endTime: active.endTime,
            costUSD: active.costUSD,
            totalTokens: active.totalTokens,
            burnRate: active.burnRate,
            projection: active.projection,
            minutes_left: Math.max(0, Math.round((new Date(active.endTime).getTime() - now) / 60000)),
          }
        : null,
      last_7d: { ...totals7d, since: last7d },
      total_blocks: blocks.length,
      generated_at: new Date().toISOString(),
    };
    usageCache = { data: summary, fetched_at: now };
    return { ...summary, cached: false, age_ms: 0 };
  } catch (e) {
    if (usageCache.data) {
      return { ...usageCache.data, cached: true, age_ms: now - usageCache.fetched_at, fetch_error: String(e.message) };
    }
    return { error: String(e.message), generated_at: new Date().toISOString() };
  }
}

// === Session usage (Agent × Model) from ccusage ===
//
// Unlike /api/llm/stats (which counts only programmatic LLM-gateway calls),
// this reflects the ACTUAL Claude-session token burn per agent, sourced from
// ccusage reading the local session transcripts. ccusage groups by `period`
// (the ~/.claude/projects/ dir slug = one per repo/agent cwd); we map each
// slug back to a registry agent. Date granularity is daily (ccusage --since/
// --until take YYYY-MM-DD), so "24h" means "today".
const SESSION_USAGE_CACHE_MS = 60 * 1000;
const sessionUsageCache = new Map(); // `${since}|${until}` → { data, fetched_at }
const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Turn a project-dir slug into a readable fallback label when it doesn't match
// a registry agent. "-Users-hulki-codex-foo-master" → "foo-master".
function slugToLabel(slug) {
  const m = String(slug).match(/^-Users-[^-]+-(?:codex|\.codex|codex-agent)-(.+)$/);
  if (m) return m[1];
  return String(slug).replace(/^-+/, "") || String(slug);
}

// Map every session-UUID to its project-dir slug by scanning the transcript
// layout ~/.claude/projects/<slug>/<uuid>.jsonl. Cheap (filenames only, no
// file reads). Returns an empty map if the dir is unreadable.
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || "", ".claude", "projects");
async function buildSessionProjectMap() {
  const map = new Map(); // uuid → project-dir slug
  let dirs;
  try {
    dirs = await fs.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try {
      files = await fs.readdir(path.join(CLAUDE_PROJECTS_DIR, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) map.set(f.slice(0, -6), d.name);
    }
  }
  return map;
}

async function fetchSessionUsage(since, until, force = false) {
  const cacheKey = `${since}|${until}`;
  const now = Date.now();
  const hit = sessionUsageCache.get(cacheKey);
  if (!force && hit && now - hit.fetched_at < SESSION_USAGE_CACHE_MS) {
    return { ...hit.data, cached: true, age_ms: now - hit.fetched_at };
  }
  try {
    const args = ["--yes", "ccusage", "session", "--json", "--breakdown", "--since", since];
    if (until) args.push("--until", until);
    const out = await new Promise((resolve, reject) => {
      const child = spawn("npx", args, {
        env: { ...process.env, PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`ccusage exit ${code}: ${stderr.slice(0, 200)}`));
      });
    });
    const parsed = JSON.parse(out);
    const sessions = Array.isArray(parsed.session) ? parsed.session : [];

    // ccusage groups by session-UUID (the `period` field) and does NOT expose
    // the project path. Resolve UUID → project-dir slug via the transcript
    // layout ~/.claude/projects/<slug>/<uuid>.jsonl so we can roll many
    // sessions up to one agent.
    const uuidToSlug = await buildSessionProjectMap();

    // Build slug → agent metadata from the registry (slug = repo path with "/" → "-").
    const registry = await readRegistry();
    const slugMap = new Map(); // slug → { key, label, color }
    for (const [key, a] of Object.entries(registry.agents || {})) {
      if (!a?.repo) continue;
      const slug = a.repo.replace(/\//g, "-");
      slugMap.set(slug, { key, label: a.display_name || key, color: a.color || null });
    }

    const matrix = {};   // key → model → { total_tokens, output_tokens, cost }
    const byAgent = {};  // key → { total_tokens, output_tokens, cost }
    const byModel = {};  // model → { total_tokens, output_tokens, cost }
    const names = {};    // key → { label, color, slug }
    const totals = { total_tokens: 0, output_tokens: 0, cost: 0 };
    const blank = () => ({ total_tokens: 0, output_tokens: 0, cost: 0 });

    for (const s of sessions) {
      const period = s.period || "?";
      // period is normally a session-UUID; resolve to its project slug. Legacy
      // entries already carry the slug directly (start with "-"). Orphans with
      // no transcript file land in an "unbekannt" bucket.
      let slug = uuidToSlug.get(period);
      if (!slug && period.startsWith("-")) slug = period;
      const matched = slug ? slugMap.get(slug) : null;
      const key = matched ? matched.key : (slug || "unbekannt");
      names[key] = names[key] || {
        label: matched ? matched.label : (slug ? slugToLabel(slug) : "unbekannt"),
        color: matched ? matched.color : null,
        slug: slug || null,
      };
      matrix[key] = matrix[key] || {};
      byAgent[key] = byAgent[key] || blank();
      const breakdowns = Array.isArray(s.modelBreakdowns) ? s.modelBreakdowns : [];
      for (const mb of breakdowns) {
        const model = mb.modelName || "?";
        const tok = (mb.inputTokens || 0) + (mb.outputTokens || 0) + (mb.cacheCreationTokens || 0) + (mb.cacheReadTokens || 0);
        const outp = mb.outputTokens || 0;
        const cost = mb.cost || 0;
        matrix[key][model] = matrix[key][model] || blank();
        matrix[key][model].total_tokens += tok;
        matrix[key][model].output_tokens += outp;
        matrix[key][model].cost += cost;
        byAgent[key].total_tokens += tok;
        byAgent[key].output_tokens += outp;
        byAgent[key].cost += cost;
        byModel[model] = byModel[model] || blank();
        byModel[model].total_tokens += tok;
        byModel[model].output_tokens += outp;
        byModel[model].cost += cost;
        totals.total_tokens += tok;
        totals.output_tokens += outp;
        totals.cost += cost;
      }
    }

    const payload = {
      matrix,
      by_agent: byAgent,
      by_model: byModel,
      names,
      totals,
      n_agents: Object.keys(matrix).length,
      n_models: Object.keys(byModel).length,
      since,
      until: until || ymdLocal(new Date()),
      generated_at: new Date().toISOString(),
    };
    sessionUsageCache.set(cacheKey, { data: payload, fetched_at: now });
    return { ...payload, cached: false, age_ms: 0 };
  } catch (e) {
    if (hit) {
      return { ...hit.data, cached: true, age_ms: now - hit.fetched_at, fetch_error: String(e.message) };
    }
    return { error: String(e.message), since, until: until || ymdLocal(new Date()), generated_at: new Date().toISOString() };
  }
}

// Plain node:https probe that ignores self-signed cert errors. Used for
// services with `allow_insecure: true` in their health_check. We do NOT
// patch the global fetch dispatcher — keeping the bypass narrow to this
// one code path means a typo in someone else's `fetch()` call can't
// accidentally accept a bad cert.
async function probeInsecureHttps(targetUrl, method, timeoutMs) {
  const { request } = await import("node:https");
  const u = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = request({
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: method === "POST" ? { "Content-Type": "application/json", "Content-Length": "2" } : {},
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    if (method === "POST") req.write("{}");
    req.end();
  });
}

async function fetchHealth(registry, force = false) {
  const now = Date.now();
  if (!force && healthCache.data && now - healthCache.fetched_at < HEALTH_CACHE_MS) {
    return { ...healthCache.data, cached: true, age_ms: now - healthCache.fetched_at };
  }
  const checks = await Promise.all(
    Object.entries(registry.agents).map(async ([key, agent]) => {
      const hc = agent.health_check;
      if (!hc || !hc.url || hc.url.includes("TBD")) return [key, { status: "skip", reason: hc?.url?.includes("TBD") ? "TBD" : "no health_check.url" }];
      try {
        const method = hc.method || "GET";
        const expected = hc.expected_status || 200;
        let httpStatus;
        if (hc.allow_insecure && hc.url.startsWith("https:")) {
          // Self-signed cert path (e.g. thermomix LXC) — bypass cert verify.
          const probed = await probeInsecureHttps(hc.url, method, 3000);
          httpStatus = probed.status;
        } else {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 3000);
          const fetchOpts = { method, signal: ctrl.signal };
          if (method === "POST") {
            fetchOpts.headers = { "Content-Type": "application/json" };
            fetchOpts.body = "{}";
          }
          const r = await fetch(hc.url, fetchOpts);
          clearTimeout(to);
          httpStatus = r.status;
        }
        return [key, { status: httpStatus === expected ? "ok" : "warn", http_status: httpStatus, expected }];
      } catch (e) {
        return [key, { status: "down", reason: String(e.message).slice(0, 100) }];
      }
    })
  );
  const data = { checks: Object.fromEntries(checks), self: await getSelfInfo(), generated_at: new Date().toISOString() };
  healthCache = { data, fetched_at: now };
  return { ...data, cached: false, age_ms: 0 };
}

// === Auto-update integration probe (for the agent matrix) ===
// "Has this agent integrated the self-updater into its web app?" We detect it by
// probing the agent's web service for /api/update/check (the uniform endpoint the
// updater exposes). A registry field `auto_update: true` short-circuits the probe.
// Cached 5 min — these are cross-LAN HTTP calls.
const UPDATER_CACHE_MS = 5 * 60 * 1000;
let updaterCache = { data: null, at: 0 };
function agentWebBase(agent) {
  const raw =
    agent.service_url ||
    (Array.isArray(agent.live_dashboards) && agent.live_dashboards[0]?.url) ||
    agent.health_check?.url ||
    null;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
async function probeAutoUpdate(registry, force = false) {
  const now = Date.now();
  if (!force && updaterCache.data && now - updaterCache.at < UPDATER_CACHE_MS) return updaterCache.data;
  const out = {};
  await Promise.all(
    Object.entries(registry.agents).map(async ([key, agent]) => {
      if (agent.auto_update === true) {
        out[key] = { has_auto_update: true, via: "registry" };
        return;
      }
      const base = agentWebBase(agent);
      if (!base) {
        out[key] = { has_auto_update: false, via: "no-url" };
        return;
      }
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 2500);
        const r = await fetch(`${base}/api/update/check`, { signal: ctrl.signal });
        clearTimeout(to);
        // Require the body to actually look like an update-check response — a bare
        // 200 from a catch-all route (or the Hub via an alias) would otherwise
        // false-positive.
        let confirmed = false;
        if (r.ok) {
          try {
            const j = await r.json();
            confirmed = !!j && (typeof j.update_available !== "undefined" || (j.current && typeof j.current === "object"));
          } catch {}
        }
        out[key] = { has_auto_update: confirmed, via: "probe", http: r.status, base };
      } catch {
        out[key] = { has_auto_update: false, via: "probe-fail", base };
      }
    })
  );
  updaterCache = { data: out, at: now };
  return out;
}

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    sseClients.delete(res);
  }
}

function resolveLive(agent, registry, liveByCwd) {
  const direct = liveByCwd.get(agent.repo);
  if (direct) return direct;
  const aliasTarget = agent.deployment?.type === "alias" ? agent.deployment.for : agent.alias_for;
  if (aliasTarget) {
    const target = registry.agents[aliasTarget];
    if (target) return liveByCwd.get(target.repo);
  }
  return null;
}

// === Idle / last-activity per agent ===
// A live Claude Code session appends to its transcript jsonl on every turn/tool
// step. The newest mtime in the session's ~/.claude/projects/<slug>/ dir is thus
// the last time the agent did anything — when it's waiting for input or sitting
// on an open question, the mtime freezes and idle time grows. Good enough proxy
// for "how long has this agent been idle in its tab" (caveat: a single very long
// tool call also looks idle until it appends). Cached 5 s so SSE ticks stay cheap.
const PROJECTS_DIR = path.join(process.env.HOME || "", ".claude", "projects");
const IDLE_CACHE_MS = 5000;
const idleCache = new Map(); // slug -> { ts, at }
function cwdToProjectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
// Read the last `bytes` of a file (transcripts can be MBs; we only need the tail).
async function readTail(file, bytes = 65536) {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

// Per-agent activity: newest transcript mtime (= last_activity_at) plus a "waiting
// for the operator" flag. Waiting = the last message-bearing transcript entry is an
// assistant turn that ENDED (stop_reason end_turn) or a pending AskUserQuestion /
// ExitPlanMode — i.e. Claude finished and is sitting on the operator. A long single
// tool call (stop_reason tool_use, or a trailing tool_result) reads as NOT waiting,
// which is what lets us tell "done, your turn" apart from "still grinding".
async function getAgentActivity(cwd) {
  const empty = { last_activity_at: null, waiting: false };
  if (!cwd) return empty;
  const slug = cwdToProjectSlug(cwd);
  const now = Date.now();
  const cached = idleCache.get(slug);
  if (cached && now - cached.at < IDLE_CACHE_MS) return cached.val;
  let newestMtime = 0;
  let newestFile = null;
  try {
    const dir = path.join(PROJECTS_DIR, slug);
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = await fs.stat(path.join(dir, f));
        if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newestFile = path.join(dir, f); }
      } catch {}
    }
  } catch {}
  let waiting = false;
  if (newestFile) {
    try {
      const lines = (await readTail(newestFile)).split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; } // skip partial first line / non-JSON
        const msg = e.message;
        if (!msg || !msg.role) continue; // skip attachment / system / summary entries
        if (msg.role === "assistant") {
          if (msg.stop_reason === "end_turn") waiting = true;
          else if (msg.stop_reason === "tool_use" && Array.isArray(msg.content)) {
            const names = msg.content.filter((b) => b && b.type === "tool_use").map((b) => b.name);
            if (names.includes("AskUserQuestion") || names.includes("ExitPlanMode")) waiting = true;
          }
        }
        break; // the last message-bearing entry decides
      }
    } catch {}
  }
  const val = { last_activity_at: newestMtime || null, waiting };
  idleCache.set(slug, { val, at: now });
  return val;
}

// Recent transcript of an agent's session, simplified for the read-only browser
// "terminal" view. Returns the last `limit` message-bearing entries.
function summarizeTranscriptEntry(e) {
  const m = e && e.message;
  if (!m || !m.role) return null;
  let text = "";
  const tools = [];
  const c = m.content;
  if (typeof c === "string") {
    text = c;
  } else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") text += b.text || "";
      else if (b.type === "tool_use") tools.push(b.name);
      else if (b.type === "tool_result") text += (text ? " " : "") + "⮑ [Tool-Ergebnis]";
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 700) text = text.slice(0, 700) + "…";
  if (!text && tools.length === 0) return null; // skip empty/thinking-only frames
  return { role: m.role, ts: e.timestamp || null, text, tools, stop_reason: m.stop_reason || null };
}

async function getAgentTranscriptTail(cwd, limit = 40) {
  if (!cwd) return [];
  const slug = cwdToProjectSlug(cwd);
  let newestFile = null;
  let newestMtime = 0;
  try {
    const dir = path.join(PROJECTS_DIR, slug);
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = await fs.stat(path.join(dir, f));
        if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newestFile = path.join(dir, f); }
      } catch {}
    }
  } catch {}
  if (!newestFile) return [];
  const out = [];
  try {
    const lines = (await readTail(newestFile, 262144)).split("\n").filter(Boolean);
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const s = summarizeTranscriptEntry(e);
      if (s) out.push(s);
    }
  } catch {}
  return out.slice(-limit);
}

async function broadcastStatus() {
  if (sseClients.size === 0) return;
  try {
    const [registry, peers] = await Promise.all([readRegistry(), fetchPeers()]);
    const liveByCwd = new Map(peers.map((p) => [p.cwd, p]));
    const agents = {};
    for (const [key, agent] of Object.entries(registry.agents)) {
      const live = resolveLive(agent, registry, liveByCwd);
      agents[key] = {
        ...agent,
        key,
        live: !!live,
        peer_id: live?.id || null,
        last_seen: live?.last_seen || null,
        live_summary: live?.summary || null,
        pid: live?.pid || null,
        tty: live?.tty || null,
        last_activity_at: live ? (await getAgentActivity(live.cwd)).last_activity_at : null,
        waiting: live ? (await getAgentActivity(live.cwd)).waiting : false,
      };
    }
    const payload = {
      agents,
      online_count: peers.length,
      total_count: Object.keys(registry.agents).length,
      meta: registry._meta || null,
      soft_stops: Object.fromEntries(softStopState),
      updated_at: new Date().toISOString(),
    };
    for (const res of sseClients) sseSend(res, "status", payload);
  } catch (e) {
    console.error("[sse] broadcast failed", e.message);
  }
}

async function broadcastUsage() {
  if (sseClients.size === 0) return;
  const [usage, planUsage] = await Promise.all([fetchUsage(), fetchPlanUsage()]);
  for (const res of sseClients) {
    sseSend(res, "usage", usage);
    sseSend(res, "plan_usage", planUsage);
  }
}

// Fire-and-forget broadcast triggered from bumpLlmUsage (synchronous on every
// /api/llm/complete success). No timer — purely event-driven, so the sidebar
// dots flip on the same tick a peer's call completes.
function broadcastLlmLive() {
  if (sseClients.size === 0) return;
  pruneLlmUsage();
  const payload = {
    now: Date.now(),
    live_window_ms: LLM_LIVE_PULSE_MS,
    recent_window_ms: LLM_RECENT_WINDOW_MS,
    by_caller: Object.fromEntries(llmUsageMap),
  };
  for (const res of sseClients) sseSend(res, "llm_live", payload);
}

// Also tick once per LLM_LIVE_PULSE_MS so the "live" → "recent" transition
// happens on its own when no new call comes in (otherwise the pulsing dot
// would never settle to the static state on the client until the next call).
setInterval(() => { if (sseClients.size) broadcastLlmLive(); }, LLM_LIVE_PULSE_MS);

setInterval(broadcastStatus, BROADCAST_MS);
setInterval(broadcastUsage, USAGE_CACHE_MS);

async function handleApi(req, res, url) {
  const send = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj, null, 2));
  };
  // Shared body-reader for any handler in this function that needs JSON
  // (sources CRUD, wa-push, briefing PUT, etc.). Declared up-front so it's
  // in scope no matter which endpoint matches first.
  const readBody = async () => {
    let raw = "";
    for await (const c of req) raw += c;
    try { return raw ? JSON.parse(raw) : {}; } catch { return null; }
  };

  // Self-describing API index — for agents that want to discover endpoints.
  if (req.method === "GET" && (url.pathname === "/api" || url.pathname === "/api/")) {
    return send(200, {
      service: "agent-master",
      version: "0.2",
      endpoints: [
        { method: "GET",  path: "/api",                  purpose: "this index" },
        { method: "GET",  path: "/api/status",           purpose: "all agents + live state + meta" },
        { method: "GET",  path: "/api/agents",           purpose: "filtered agent list",
          query: { capability: "filter by capability", role: "Hub|Bridge|Domain|Infra", tag: "filter by tag", live: "true|false" } },
        { method: "GET",  path: "/api/registry",         purpose: "raw registry JSON" },
        { method: "POST", path: "/api/registry/self-update", purpose: "an agent patches its OWN registry entry (merged). Fields: capabilities, when_to_use, owned_endpoints, mqtt_topics, depends_on, tags, description, display_name, service_url, live_dashboards, repo_url.", body: { agent: "<key>", capabilities: ["…"], when_to_use: ["…"], owned_endpoints: [{ method: "GET", path: "/api/…", purpose: "…" }] } },
        { method: "GET",  path: "/api/agent-transcript",  purpose: "read-only recent session transcript of an agent (browser 'terminal' view). ?agent=<key>&limit=40" },
        { method: "GET",  path: "/api/peers",            purpose: "broker peers + agent metadata merged" },
        { method: "GET",  path: "/api/health",           purpose: "HTTP health-check pings, 60 s cached (+ self: version/commit)" },
        { method: "GET",  path: "/api/update/check",     purpose: "self-update: latest GitHub release vs running commit (10 min cached; ?refresh=1)" },
        { method: "GET",  path: "/api/update/status",    purpose: "self-update: progress of an in-flight apply (poll)" },
        { method: "POST", path: "/api/update/apply",     purpose: "self-update: apply a release in-place + restart. body: { tag? } — defaults to latest. Manual-only." },
        { method: "GET",  path: "/api/agent-updaters",   purpose: "per-agent 'has the self-updater integrated' map (probes <web>/api/update/check; 5 min cached). Powers the Matrix tab." },
        { method: "GET",  path: "/api/usage",            purpose: "ccusage cost overlay (5 min cached)" },
        { method: "GET",  path: "/api/plan-usage",       purpose: "Claude Code plan % (5 min cached)" },
        { method: "GET",  path: "/api/events",           purpose: "SSE stream: status (3 s), usage + plan_usage (5 min)" },
        { method: "POST", path: "/api/agents/create",    purpose: "scaffold + auto-spawn a brand-new agent workspace (~/codex/<name>/ + git init + registry append)", body: { name: "<kebab-case>", mission: "<10-500 chars>" } },
        { method: "GET",  path: "/api/llm/models",       purpose: "list available logical models (sonnet/haiku/opus) + registered external backends (e.g. klick:best). Pass ?probe_ollama=1 to enumerate Ollama-installed local models" },
        { method: "POST", path: "/api/llm/complete",     purpose: "delegate a single-shot LLM completion. Default routes to `claude` CLI (Pro-plan, no extra API cost). External backends like `klick:best` (Jonas' Mac Studio Qwen) route via OpenAI-compat and don't touch the Anthropic plan", body: { model: "sonnet|haiku|opus|local:<n>|klick:best|klick:fast|klick:long-context|klick:small", prompt: "<str>", system: "<str?>", max_tokens: 1024, json_schema: "{}?", caller: "<your-repo-key>", template: "<optional template name, see /api/llm/templates>" } },
        { method: "POST", path: "/api/llm/complete/stream", purpose: "same as /api/llm/complete but streams tokens as SSE — events: text, thinking (if include_thinking:true), rate_limit, done, error", body: { model: "sonnet|haiku|opus", prompt: "<str>", caller: "<your-repo>", template: "<optional>", include_thinking: "false" } },
        { method: "GET",  path: "/api/llm/templates",    purpose: "list available prompt-templates (commit-msg, log-summary, german-ui, …) — pass ?include_system=1 to see full system prompts" },
        { method: "GET",  path: "/api/llm/cache",        purpose: "in-memory response-cache stats (hits/misses/size). ?clear=1 wipes the cache. Cache is keyed on SHA256(model+system+prompt+json_schema+max_tokens), default TTL 5min, override per-call via cache_ttl_ms or disable via cache:false" },
        { method: "GET",  path: "/api/llm/stats",        purpose: "per-caller / per-model usage rollups (last 24h + 7d) from InfluxDB llm_call measurement" },
        { method: "POST", path: "/api/spawn",            purpose: "spawn an agent",   body: { agent: "<key>" } },
        { method: "POST", path: "/api/focus",            purpose: "bring a live agent's Terminal window to the front (macOS)", body: { agent: "<key>" } },
        { method: "POST", path: "/api/recycle",          purpose: "context-window recycle: stop the agent → respawn → send 'weiter'. Agent triggers it when its context monitor is CRITICAL and it has written a handoff + pushed. Not the Hub.", body: { agent: "<key>", requested_by: "agent|operator", reason: "<text>?" } },
        { method: "POST", path: "/api/peer/notify",      purpose: "reuse-or-spawn escalation: deliver a context message to a peer session (channel-message if alive, else spawn first then deliver). For external scripts that can only reach the hub over HTTP.", body: { repo: "<key>", context: "<message>", reuse_if_alive: true, spawn_if_offline: true, source: "<caller-id>?" } },
        { method: "POST", path: "/api/stop",             purpose: "hard-stop an agent (SIGTERM + close tab). requested_by:'agent' marks an agent self-stop (always honored + logged).", body: { agent: "<key>", requested_by: "operator|agent", reason: "<text>?" } },
        { method: "POST", path: "/api/soft-stop",        purpose: "soft-stop: ask agent to save & wrap up, hard-stop after 5 min if it doesn't extend", body: { agent: "<key>" } },
        { method: "POST", path: "/api/soft-stop-extend", purpose: "request +5 min extension (one-shot, callable by the agent itself via curl)", body: { agent: "<key>" } },
        { method: "POST", path: "/api/soft-stop-cancel", purpose: "abort a pending soft-stop, agent keeps running normally", body: { agent: "<key>" } },
        { method: "GET",  path: "/api/skills",           purpose: "all installed Claude Code skills (parsed from ~/.claude/skills/*/SKILL.md), grouped by cluster",
          query: { refresh: "1 to bypass the 5 min cache" } },
        { method: "GET",  path: "/api/skills/body",      purpose: "full SKILL.md body (post-frontmatter) for one skill — for the UI detail panel",
          query: { path: "absolute path returned by /api/skills (must be under ~/.claude/skills/ or ~/.claude/plugins/cache/)" } },
        { method: "GET",  path: "/api/briefing",         purpose: "current peer-briefing text + history of who has been briefed" },
        { method: "PUT",  path: "/api/briefing",         purpose: "update the peer-briefing.md content. body: { text } — next-spawned peer gets new version automatically" },
        { method: "POST", path: "/api/briefing/rebrief", purpose: "re-send briefing to one peer (or all). body: { peer_id } | { cwd } | { all: true }" },
        { method: "GET",  path: "/api/skill-usage",      purpose: "loop state + InfluxDB target. Scans transcripts every 5 min, ships Skill tool_use events.",
          query: { trigger: "1 to fire the scan once now (still respects --since-ms overlap)" } },
        { method: "GET",  path: "/api/skill-usage/aggregated", purpose: "per-skill counts (total/7d/30d/last_used) + headline totals — feeds the Skills-tab heatmap. Cached 60s.",
          query: { refresh: "1 to bypass the 60s cache" } },
        { method: "GET",  path: "/api/recent-activity", purpose: "merged feed of last skill_invocations + hub_events, normalized {ts,kind,label,detail}. Cached 30s.",
          query: { limit: "N events (default 10)", refresh: "1 to bypass cache" } },
        { method: "GET",    path: "/api/sources",           purpose: "list configured data sources (InfluxDB etc.); tokens redacted" },
        { method: "POST",   path: "/api/sources",           purpose: "create source. body: { name, type:'influxdb2', url, org, bucket, token, default? }" },
        { method: "PATCH",  path: "/api/sources/:id",       purpose: "update source. body subset of POST fields; omit token to keep current" },
        { method: "DELETE", path: "/api/sources/:id",       purpose: "delete source. cannot delete the default one if other sources exist." },
        { method: "POST",   path: "/api/sources/:id/set-default", purpose: "promote one source to default for its type" },
        { method: "POST",   path: "/api/sources/:id/test",  purpose: "ping the source's /health endpoint. Returns {ok, status, message}" },
        { method: "GET",    path: "/api/wa-push",           purpose: "WA-push gateway status: outbox path, dedup cache, rate-limit window" },
        { method: "POST",   path: "/api/wa-push",           purpose: "push a WhatsApp message to Jörg via wa-bridge. body: { text, severity:info|warn|error|recovered, source, dedup_key?, to_phone? }. Dedup 10min, rate-limit 30/5min." },
        { method: "GET",    path: "/api/health-monitor",    purpose: "health-monitor loop status + per-box current issues. Dormant until an agent has health_monitor.enabled=true with boxes in the registry." },
        { method: "POST",   path: "/api/health-monitor/poll", purpose: "force an immediate poll cycle (returns after completion)." },
      ],
      notes: "All responses are JSON. No auth — LAN only. Spawn/stop drives Terminal.app via AppleScript on macOS.",
    });
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    const force = url.searchParams.get("refresh") === "1";
    return send(200, await readSkills({ force }));
  }

  // Aggregated skill usage for the Skills-tab heatmap. Reads the last 365d
  // from InfluxDB, returns per-skill counts + totals. Cached 60s.
  if (req.method === "GET" && url.pathname === "/api/skill-usage/aggregated") {
    const force = url.searchParams.get("refresh") === "1";
    return send(200, await getSkillUsageAggregated({ force }));
  }

  // WA-Push gateway: POST sends a message via wa-bridge outbox; GET shows
  // gateway state (dedup cache, rate-limit window, outbox path).
  if (req.method === "GET" && url.pathname === "/api/wa-push") {
    const now = Date.now();
    while (waRateWindow.length && waRateWindow[0] < now - WA_RATE_LIMIT_WINDOW_MS) waRateWindow.shift();
    return send(200, {
      default_phone: WA_DEFAULT_PHONE,
      outbox_dir: WA_OUTBOX_DIR,
      outbox_exists: existsSync(WA_OUTBOX_DIR),
      severity_prefixes: WA_SEVERITY_PREFIX,
      dedup: {
        ttl_ms: WA_DEDUP_TTL_MS,
        active: [...waDedupCache.entries()]
          .filter(([, exp]) => exp > now)
          .map(([key, exp]) => ({ key, expires_in_ms: exp - now })),
      },
      rate_limit: {
        window_ms: WA_RATE_LIMIT_WINDOW_MS,
        max_per_window: WA_RATE_LIMIT_COUNT,
        current_count: waRateWindow.length,
      },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/wa-push") {
    const body = await readBody();
    if (!body) return send(400, { error: "invalid_json" });
    const result = await waPush(body);
    if (!result.ok) {
      if (result.error === "rate_limited") return send(429, result);
      return send(400, result);
    }
    return send(200, result);
  }

  // Health-monitor: status reader + manual trigger.
  if (req.method === "GET" && url.pathname === "/api/health-monitor") {
    return send(200, {
      poll_interval_ms: HEALTH_POLL_MS,
      fetch_timeout_ms: HEALTH_FETCH_TIMEOUT_MS,
      state: healthMonitorState,
      boxes: healthState.boxes || {},
    });
  }
  if (req.method === "POST" && url.pathname === "/api/health-monitor/poll") {
    await healthMonitorTick();
    return send(200, { ok: true, state: healthMonitorState });
  }

  // Recent-activity feed: last skill calls + hub audit events merged.
  if (req.method === "GET" && url.pathname === "/api/recent-activity") {
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10)));
    const force = url.searchParams.get("refresh") === "1";
    return send(200, await getRecentActivity({ limit, force }));
  }

  // === Sources CRUD ===
  if (req.method === "GET" && url.pathname === "/api/sources") {
    const cfg = await loadSources();
    return send(200, { sources: cfg.sources.map(redactSource) });
  }

  if (req.method === "POST" && url.pathname === "/api/sources") {
    const body = await readBody();
    if (!body) return send(400, { error: "invalid_json" });
    const { name, type = "influxdb2", url: srcUrl, org, bucket, token } = body;
    if (!name || !srcUrl || !token) return send(400, { error: "missing_fields", required: ["name","url","token"] });
    const cfg = await loadSources();
    const isFirstOfType = !cfg.sources.some((s) => s.type === type);
    const entry = {
      id: genSourceId(),
      name: String(name),
      type: String(type),
      url: String(srcUrl).replace(/\/+$/, ""),
      org: String(org || ""),
      bucket: String(bucket || ""),
      token: String(token),
      default: !!body.default || isFirstOfType,
      created_at: new Date().toISOString(),
    };
    if (entry.default) {
      for (const s of cfg.sources) if (s.type === type) s.default = false;
    }
    cfg.sources.push(entry);
    await saveSources();
    // Bust caches that depend on the source.
    skillUsageAggCache = { data: null, fetched_at: 0, error: null };
    auditEvent("source.create", { target: entry.id, source_type: entry.type, is_default: String(entry.default) }, `Source angelegt: ${entry.name}`).catch(() => {});
    return send(201, { source: redactSource(entry) });
  }

  // /api/sources/:id and sub-actions
  const sourceMatch = url.pathname.match(/^\/api\/sources\/([a-zA-Z0-9_]+)(?:\/(set-default|test))?$/);
  if (sourceMatch) {
    const id = sourceMatch[1];
    const action = sourceMatch[2];
    const cfg = await loadSources();
    const idx = cfg.sources.findIndex((s) => s.id === id);
    if (idx < 0) return send(404, { error: "unknown_source", id });
    const src = cfg.sources[idx];

    if (req.method === "PATCH" && !action) {
      const body = await readBody();
      if (!body) return send(400, { error: "invalid_json" });
      const changed = [];
      for (const k of ["name","url","org","bucket"]) {
        if (k in body && body[k] != null) { src[k] = String(body[k]); changed.push(k); }
      }
      if (body.url) src.url = src.url.replace(/\/+$/, "");
      if (typeof body.token === "string" && body.token.trim()) { src.token = body.token.trim(); changed.push("token"); }
      if (body.default === true) {
        for (const s of cfg.sources) if (s.type === src.type) s.default = (s.id === id);
        changed.push("default");
      }
      await saveSources();
      skillUsageAggCache = { data: null, fetched_at: 0, error: null };
      auditEvent("source.update", { target: id }, `Source aktualisiert (${changed.join(",") || "no-op"}): ${src.name}`).catch(() => {});
      return send(200, { source: redactSource(src) });
    }

    if (req.method === "DELETE" && !action) {
      const sameType = cfg.sources.filter((s) => s.type === src.type);
      if (src.default && sameType.length > 1) {
        return send(400, { error: "cannot_delete_default", hint: "promote another source first via POST /api/sources/:id/set-default" });
      }
      const deletedName = src.name;
      cfg.sources.splice(idx, 1);
      // If we removed the only source of its type, nothing to repromote.
      // If we removed a non-default and other sources exist, default stays.
      await saveSources();
      skillUsageAggCache = { data: null, fetched_at: 0, error: null };
      auditEvent("source.delete", { target: id }, `Source gelöscht: ${deletedName}`).catch(() => {});
      return send(200, { deleted: id });
    }

    if (req.method === "POST" && action === "set-default") {
      for (const s of cfg.sources) if (s.type === src.type) s.default = (s.id === id);
      await saveSources();
      skillUsageAggCache = { data: null, fetched_at: 0, error: null };
      auditEvent("source.set_default", { target: id }, `Default-Source: ${src.name}`).catch(() => {});
      return send(200, { source: redactSource(src) });
    }

    if (req.method === "POST" && action === "test") {
      // InfluxDB v2 health endpoint is unauthenticated, so a 200 means the
      // host is up. We also probe a tokenized /api/v2/buckets/:bucket call
      // to confirm the token + bucket are valid.
      const r1 = await fetch(`${src.url}/health`).catch((e) => ({ ok: false, status: 0, errMsg: e.message }));
      const healthOk = r1.ok;
      let bucketOk = null;
      let bucketMsg = null;
      if (src.type === "influxdb2" && src.bucket) {
        try {
          const r2 = await fetch(`${src.url}/api/v2/buckets?name=${encodeURIComponent(src.bucket)}&org=${encodeURIComponent(src.org)}`, {
            headers: { "Authorization": `Token ${src.token}` },
          });
          bucketOk = r2.ok;
          if (!r2.ok) bucketMsg = `HTTP ${r2.status}: ${(await r2.text()).slice(0, 140)}`;
        } catch (e) {
          bucketOk = false;
          bucketMsg = e.message;
        }
      }
      const overallOk = healthOk && (bucketOk === null || bucketOk);
      auditEvent("source.test", { target: id, ok: String(overallOk) }, `Source-Test ${overallOk ? "OK" : "FAIL"}: ${src.name}`).catch(() => {});
      return send(200, {
        ok: overallOk,
        health: { ok: healthOk, status: r1.status || 0, error: r1.errMsg || null },
        bucket: { ok: bucketOk, error: bucketMsg },
      });
    }
  }

  // Skill-usage loop status. `?trigger=1` forces an immediate scan and waits
  // for it (useful after manual transcript activity, no need to wait 5 min).
  if (req.method === "GET" && url.pathname === "/api/skill-usage") {
    if (url.searchParams.get("trigger") === "1") await skillUsageTick();
    return send(200, {
      script: SKILL_USAGE_SCRIPT,
      influx_url: process.env.INFLUX_URL || "http://172.25.0.111:8086",
      influx_org: process.env.INFLUX_ORG || "meintechblog",
      influx_bucket: process.env.INFLUX_BUCKET || "default",
      poll_interval_ms: SKILL_USAGE_POLL_MS,
      lookback_ms: SKILL_USAGE_LOOKBACK_MS,
      state: skillUsageState,
    });
  }

  // Update the briefing markdown from the UI. Wraps fs.writeFile with a
  // single audit event so changes show up in the activity feed.
  if (req.method === "PUT" && url.pathname === "/api/briefing") {
    const body = await readBody();
    if (!body) return send(400, { error: "invalid_json" });
    if (typeof body.text !== "string" || !body.text.trim()) return send(400, { error: "missing_text" });
    try {
      await fs.writeFile(BRIEFING_MD_PATH, body.text);
      auditEvent("briefing.edit", { target: "peer-briefing.md", bytes: String(body.text.length) }, `Briefing-MD aktualisiert (${body.text.length} bytes)`).catch(() => {});
      return send(200, { ok: true, bytes: body.text.length, path: BRIEFING_MD_PATH });
    } catch (err) {
      return send(500, { error: "write_failed", reason: err.message });
    }
  }

  // Briefing inspector: current MD content + log of who was briefed when.
  // Helps Jörg see whether new peers actually get the message and edit the
  // text without ssh-ing into the box.
  if (req.method === "GET" && url.pathname === "/api/briefing") {
    const text = await getBriefingText();
    const history = Object.fromEntries(briefedPeers);
    return send(200, {
      briefing_path: BRIEFING_MD_PATH,
      briefing_bytes: text ? text.length : 0,
      briefing_text: text || null,
      poll_interval_ms: BRIEFING_POLL_MS,
      history,
      history_count: briefedPeers.size,
    });
  }

  // Force a re-briefing: { peer_id } targets one peer, { cwd } resolves first
  // matching peer, { all: true } re-briefs every currently-online peer.
  // Useful when you've edited peer-briefing.md and want existing peers to see
  // the new version.
  if (req.method === "POST" && url.pathname === "/api/briefing/rebrief") {
    // Inline body read — readJson() is declared later in this function.
    let raw = "";
    for await (const c of req) raw += c;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: "invalid_json" }); }
    const peers = await fetchPeers();
    let targets = [];
    if (body.all) targets = peers;
    else if (body.peer_id) targets = peers.filter((p) => p.id === body.peer_id);
    else if (body.cwd) targets = peers.filter((p) => p.cwd === body.cwd);
    else return send(400, { error: "missing_target", hint: "send { peer_id } | { cwd } | { all: true }" });
    if (!targets.length) return send(404, { error: "no_matching_peer", peers_online: peers.length });
    const results = [];
    for (const p of targets) {
      // Force=true so we override the already-briefed flag for these targets.
      results.push({ peer_id: p.id, cwd: p.cwd, ...(await briefPeer(p, { force: true })) });
    }
    return send(200, { rebriefed: results.length, results });
  }

  // Return the body (post-frontmatter) of one SKILL.md. Path must be one
  // returned by /api/skills (validated against the two trusted roots).
  if (req.method === "GET" && url.pathname === "/api/skills/body") {
    const requested = url.searchParams.get("path");
    const abs = safeSkillPath(requested);
    if (!abs) return send(400, { error: "invalid_path", hint: "path must be a SKILL.md under ~/.claude/skills/ or ~/.claude/plugins/cache/" });
    if (!existsSync(abs)) return send(404, { error: "not_found", path: abs });
    const raw = await fs.readFile(abs, "utf8");
    return send(200, { path: abs, body: stripFrontmatter(raw), bytes: raw.length });
  }

  // Discovery: filtered agent list. Lets a peer ask "give me agents that can X"
  // without grep-ing the whole registry.
  if (req.method === "GET" && url.pathname === "/api/agents") {
    const [registry, peers] = await Promise.all([readRegistry(), fetchPeers()]);
    const liveByCwd = new Map(peers.map((p) => [p.cwd, p]));
    const capFilter = url.searchParams.get("capability");
    const roleFilter = url.searchParams.get("role");
    const tagFilter  = url.searchParams.get("tag");
    const liveFilter = url.searchParams.get("live");
    const matches = [];
    for (const [key, agent] of Object.entries(registry.agents)) {
      const live = !!resolveLive(agent, registry, liveByCwd);
      if (capFilter  && !(agent.capabilities || []).includes(capFilter))  continue;
      if (roleFilter && agent.role !== roleFilter)                         continue;
      if (tagFilter  && !(agent.tags || []).includes(tagFilter))           continue;
      if (liveFilter === "true"  && !live)                                 continue;
      if (liveFilter === "false" &&  live)                                 continue;
      matches.push({ key, role: agent.role, display_name: agent.display_name || null, description: agent.description, capabilities: agent.capabilities || [], tags: agent.tags || [], live, repo: agent.repo });
    }
    return send(200, { matches, count: matches.length, filters: { capability: capFilter, role: roleFilter, tag: tagFilter, live: liveFilter } });
  }

  if (req.method === "GET" && url.pathname === "/api/registry") return send(200, await readRegistry());

  // An agent patches its OWN registry entry (capabilities / when_to_use / owned_endpoints / …).
  if (req.method === "POST" && url.pathname === "/api/registry/self-update") {
    const body = (await readBody()) || {};
    const key = body.agent;
    if (!key) return send(400, { error: "missing_agent" });
    const registry = await readRegistry();
    if (!registry.agents[key]) return send(404, { error: "unknown_agent" });
    const applied = {};
    for (const [f, v] of Object.entries(body)) {
      if (f === "agent") continue;
      if (!REGISTRY_FILLABLE.has(f)) continue;
      registry.agents[key][f] = v;
      applied[f] = Array.isArray(v) ? v.length : typeof v;
    }
    if (Object.keys(applied).length === 0) return send(400, { error: "no_fillable_fields", allowed: [...REGISTRY_FILLABLE] });
    await writeRegistryAtomic(registry);
    const fillState = await readFillState();
    fillState[key] = { ...(fillState[key] || {}), last_filled_at: Date.now() };
    await writeFillState(fillState);
    auditEvent("registry.self_update", { target: key }, `Self-update ${key}: ${Object.keys(applied).join(", ")}`).catch(() => {});
    return send(200, { ok: true, agent: key, applied });
  }

  // Live-chat: send a message from the dashboard straight into an agent's session
  // via the claude-peers broker. The reply shows up in the transcript poll.
  if (req.method === "POST" && url.pathname === "/api/agent-chat") {
    const body = (await readBody()) || {};
    const key = body.agent;
    const text = (body.text || "").trim();
    if (!key) return send(400, { error: "missing_agent" });
    if (!text) return send(400, { error: "empty_text" });
    const registry = await readRegistry();
    const agent = registry.agents[key];
    if (!agent) return send(404, { error: "unknown_agent" });
    const peers = await fetchPeers();
    const peer = peers.find((p) => p.cwd === agent.repo);
    if (!peer) return send(409, { error: "agent_offline", agent: key });
    try {
      await sendChannelMessage(peer.id, `💬 [Jörg via Dashboard-Chat]: ${text}`);
      auditEvent("agent.chat", { target: key }, `Dashboard-Chat → ${key}: ${text.slice(0, 80)}`).catch(() => {});
      return send(200, { ok: true, agent: key, peer_id: peer.id });
    } catch (e) {
      return send(500, { error: "send_failed", reason: String(e.message) });
    }
  }

  // Read-only "terminal in the browser": the recent transcript of an agent's session.
  if (req.method === "GET" && url.pathname === "/api/agent-transcript") {
    const key = url.searchParams.get("agent");
    const limit = Math.min(120, Math.max(5, parseInt(url.searchParams.get("limit") || "40", 10)));
    const registry = await readRegistry();
    const agent = registry.agents[key];
    if (!agent) return send(404, { error: "unknown_agent" });
    const peers = await fetchPeers();
    const peer = peers.find((p) => p.cwd === agent.repo);
    const cwd = peer?.cwd || agent.repo;
    return send(200, { agent: key, live: !!peer, cwd, messages: await getAgentTranscriptTail(cwd, limit) });
  }

  if (req.method === "GET" && url.pathname === "/api/peers") {
    const [registry, peers] = await Promise.all([readRegistry(), fetchPeers()]);
    const merged = peers.map((p) => {
      const key = findAgentKeyForCwd(registry, p.cwd);
      return { ...p, agent_key: key, agent: key ? registry.agents[key] : null };
    });
    return send(200, { peers: merged, online_count: peers.length });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const [registry, peers] = await Promise.all([readRegistry(), fetchPeers()]);
    const liveByCwd = new Map(peers.map((p) => [p.cwd, p]));
    const agents = {};
    for (const [key, agent] of Object.entries(registry.agents)) {
      const live = resolveLive(agent, registry, liveByCwd);
      agents[key] = {
        ...agent,
        key,
        live: !!live,
        peer_id: live?.id || null,
        last_seen: live?.last_seen || null,
        live_summary: live?.summary || null,
        pid: live?.pid || null,
        tty: live?.tty || null,
        last_activity_at: live ? (await getAgentActivity(live.cwd)).last_activity_at : null,
        waiting: live ? (await getAgentActivity(live.cwd)).waiting : false,
      };
    }
    return send(200, {
      agents,
      online_count: peers.length,
      total_count: Object.keys(registry.agents).length,
      meta: registry._meta || null,
      soft_stops: Object.fromEntries(softStopState),
      updated_at: new Date().toISOString(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/agent-updaters") {
    const registry = await readRegistry();
    return send(200, { updaters: await probeAutoUpdate(registry, url.searchParams.get("refresh") === "1"), generated_at: new Date().toISOString() });
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    return send(200, await fetchUsage(url.searchParams.get("refresh") === "1"));
  }

  if (req.method === "GET" && url.pathname === "/api/plan-usage") {
    return send(200, await fetchPlanUsage(url.searchParams.get("refresh") === "1"));
  }

  if (req.method === "GET" && url.pathname === "/api/session-usage") {
    // Per-agent × per-model Claude SESSION token usage from ccusage (not the
    // LLM gateway). Date-granular: since/until are YYYY-MM-DD; defaults to the
    // last 7 days. Aggregated server-side; cached 60s per (since,until).
    const qSince = url.searchParams.get("since");
    const qUntil = url.searchParams.get("until");
    const since = isYmd(qSince) ? qSince : ymdLocal(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const until = isYmd(qUntil) ? qUntil : ymdLocal(new Date());
    const force = url.searchParams.get("refresh") === "1";
    return send(200, await fetchSessionUsage(since, until, force));
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const registry = await readRegistry();
    return send(200, await fetchHealth(registry, url.searchParams.get("refresh") === "1"));
  }

  // ── Self-update (manual-only, release-gated) ───────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/update/check") {
    return send(200, await checkForUpdate(url.searchParams.get("refresh") === "1"));
  }
  if (req.method === "GET" && url.pathname === "/api/update/status") {
    const st = await readUpdateState();
    return send(200, { self: await getSelfInfo(), state: st });
  }
  if (req.method === "POST" && url.pathname === "/api/update/apply") {
    const body = (await readBody()) || {};
    // Re-check so we never apply when nothing is actually available.
    const chk = await checkForUpdate(true);
    if (!chk.ok) return send(502, { started: false, reason: "check_failed", error: chk.error });
    const tag = body.tag || chk.latest?.tag;
    if (!tag) return send(400, { started: false, reason: "no_target_tag" });
    if (!body.tag && !chk.update_available) {
      return send(409, { started: false, reason: "no_update_available", current: chk.current, latest: chk.latest });
    }
    const result = await startApply({ tag });
    auditEvent("hub_update_apply", { target: "agent-master" }, { tag, ...result });
    return send(result.started ? 202 : 409, result);
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`: connected\n\n`);
    sseClients.add(res);
    broadcastStatus().catch(() => {});
    // Push an immediate llm_live snapshot so the new client doesn't have to
    // wait for the first call or the heartbeat interval.
    pruneLlmUsage();
    sseSend(res, "llm_live", {
      now: Date.now(),
      live_window_ms: LLM_LIVE_PULSE_MS,
      recent_window_ms: LLM_RECENT_WINDOW_MS,
      by_caller: Object.fromEntries(llmUsageMap),
    });
    fetchUsage().then((u) => sseSend(res, "usage", u));
    fetchPlanUsage().then((p) => sseSend(res, "plan_usage", p));
    req.on("close", () => sseClients.delete(res));
    return;
  }

  const readJson = async () => {
    let body = "";
    for await (const c of req) body += c;
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      return null;
    }
  };

  if (req.method === "GET" && url.pathname === "/api/llm/models") {
    const probeOllama = url.searchParams.get("probe_ollama") === "1";
    const models = await llmListModels(probeOllama);
    // Decorate external backends with circuit + heartbeat so callers see
    // health in one call without hitting /api/llm/circuits separately.
    const circuits = llmGetCircuitStats();
    if (Array.isArray(models.external)) {
      models.external = models.external.map((b) => {
        const c = circuits[b.name];
        const hb = backendHeartbeat.get(b.name);
        const lastOkMs = hb?.last_successful_at ? Date.now() - new Date(hb.last_successful_at).getTime() : null;
        // Status synthesizes circuit + heartbeat:
        //   "down"      = circuit open OR heartbeat never succeeded
        //   "degraded"  = closed but last heartbeat > 10min ago
        //   "ok"        = closed and recent heartbeat (within 10min)
        //   "unknown"   = no traffic and no heartbeat yet
        let status = "unknown";
        if (c?.state === "open") status = "down";
        else if (lastOkMs == null) status = "unknown";
        else if (lastOkMs > 10 * 60 * 1000) status = "degraded";
        else status = "ok";
        return { ...b, circuit: c?.state || "closed", status, last_successful_at: hb?.last_successful_at || null, consecutive_failures: hb?.consecutive_failures || 0 };
      });
    }
    return send(200, models);
  }

  if (req.method === "GET" && url.pathname === "/api/llm/circuits") {
    // Snapshot circuit-breaker state per backend, plus heartbeat from the
    // discovery loop. ?force_close=<backend> / ?force_open=<backend> are
    // operator overrides for "I fixed it, retry now" or "I'm taking this
    // backend down for maintenance".
    const fc = url.searchParams.get("force_close");
    const fo = url.searchParams.get("force_open");
    if (fc) {
      const ok = llmForceCloseCircuit(fc);
      auditEvent("circuit.force_closed", { target: fc }, `Operator force-closed circuit ${fc}`).catch(() => {});
      return send(ok ? 200 : 404, { force_closed: fc, ok });
    }
    if (fo) {
      const ok = llmForceOpenCircuit(fo);
      auditEvent("circuit.force_opened", { target: fo }, `Operator force-opened circuit ${fo}`).catch(() => {});
      return send(ok ? 200 : 404, { force_opened: fo, ok });
    }
    const circuits = llmGetCircuitStats();
    // Merge with heartbeat for one-shot view.
    const merged = {};
    const names = new Set([...Object.keys(circuits), ...backendHeartbeat.keys()]);
    for (const n of names) {
      merged[n] = {
        circuit: circuits[n] || { state: "closed", note: "no traffic yet" },
        heartbeat: backendHeartbeat.get(n) || null,
      };
    }
    return send(200, { backends: merged, generated_at: new Date().toISOString() });
  }

  if (req.method === "GET" && url.pathname === "/api/llm/discovery") {
    // Status of the external-model auto-discovery loop. ?run=1 forces a tick.
    if (url.searchParams.get("run") === "1") {
      const events = await discoverExternalModelsOnce();
      return send(200, { ran_now: true, events, state: { last_run_at: externalDiscoveryState.last_run_at, last_error: externalDiscoveryState.last_error } });
    }
    return send(200, {
      last_run_at: externalDiscoveryState.last_run_at,
      last_summary: externalDiscoveryState.last_summary,
      last_error: externalDiscoveryState.last_error,
      poll_interval_ms: EXTERNAL_DISCOVERY_POLL_MS,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/llm/cache") {
    // Cache status: size, hits, misses, evictions. ?clear=1 wipes it.
    if (url.searchParams.get("clear") === "1") {
      return send(200, { cleared: true, ...llmClearCache() });
    }
    return send(200, llmGetCacheStats());
  }

  if (req.method === "GET" && url.pathname === "/api/llm/templates") {
    // Discovery for peers: which prompt-templates exist + their defaults.
    // ?include_system=1 returns the full system prompt (larger payload).
    const includeSystem = url.searchParams.get("include_system") === "1";
    return send(200, {
      templates: llmListTemplates(includeSystem),
      usage_hint: "POST /api/llm/complete with { template: \"<name>\", input: \"<text>\", caller: \"<your-repo>\" }",
    });
  }

  if (req.method === "GET" && url.pathname === "/api/llm/live") {
    // Cheap per-caller mini-stats for the sidebar dots. Built from the
    // in-memory llmUsageMap that gets updated on every /api/llm/complete call.
    pruneLlmUsage();
    return send(200, {
      now: Date.now(),
      live_window_ms: LLM_LIVE_PULSE_MS,
      recent_window_ms: LLM_RECENT_WINDOW_MS,
      by_caller: Object.fromEntries(llmUsageMap),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/llm/complete") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    const caller = String(parsed.caller || "unknown").slice(0, 60);
    try {
      const result = await llmComplete(parsed);
      // In-memory tracking for the sidebar live-dots (cheap, no influx roundtrip).
      // Cache hits don't count as plan-burn — log them but don't bump live-dots.
      const isCacheHit = result.cache_status === "hit";
      if (!isCacheHit) {
        bumpLlmUsage(caller, result.logical_model, result.usage.total_tokens, result.latency_ms);
        // InfluxDB row only on actual call (miss/skip). Otherwise stats would double-count cached calls.
        writeInfluxLines([
          `llm_call,caller=${escTagValue(caller)},model=${escTagValue(result.logical_model)},provider=${escTagValue(result.provider)} `
          + `input_tokens=${result.usage.input_tokens}i,`
          + `cache_creation_tokens=${result.usage.cache_creation_input_tokens}i,`
          + `cache_read_tokens=${result.usage.cache_read_input_tokens}i,`
          + `output_tokens=${result.usage.output_tokens}i,`
          + `total_tokens=${result.usage.total_tokens}i,`
          + `latency_ms=${result.latency_ms}i,`
          + `raw_cost_usd=${result.raw_cost_usd || 0},`
          + `shadow_cost_usd=${result.shadow_cost?.estimated_usd || 0}`
          + ` ${BigInt(Date.now()) * 1_000_000n}`
        ]).catch(() => {});
      }
      auditEvent("llm.call", {
        target: caller,
        model: result.logical_model || parsed.model || "?",
        provider: result.provider,
      }, `LLM ${result.logical_model} ← ${caller} (${isCacheHit ? "cache" : result.usage.total_tokens + "t"}, ${result.latency_ms}ms${result.fallback ? `, FALLBACK: ${result.fallback.from}→${result.fallback.to}` : ""}${result.shadow_cost ? `, saved $${result.shadow_cost.estimated_usd.toFixed(4)}` : ""})`).catch(() => {});
      res.setHeader("X-Cache", result.cache_status || "skip");
      if (result.fallback) res.setHeader("X-Fallback", `${result.fallback.from}->${result.fallback.to}`);
      // Attach plan-usage hint so callers can self-pace when quota tightens.
      // Uses the in-memory cached payload (5min TTL) — never blocks the call.
      try {
        const hint = buildPlanUsageHint(planUsageCache?.data);
        if (hint) result.plan_usage_hint = hint;
      } catch { /* hint is best-effort */ }
      return send(200, result);
    } catch (e) {
      auditEvent("llm.call.fail", { target: caller, model: parsed.model || "?" }, `LLM FAIL ${caller}: ${e.message.slice(0, 80)}`).catch(() => {});
      return send(500, { error: "llm_failed", reason: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/llm/complete/stream") {
    // SSE stream: forward each text/thinking delta as its own event. Final
    // `done` event carries the full result object (same shape as POST /complete).
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    const caller = String(parsed.caller || "unknown").slice(0, 60);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`: stream open\n\n`);
    let closed = false;
    req.on("close", () => { closed = true; });
    const writeEvent = (event, data) => {
      if (closed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const result = await llmCompleteStream(parsed, (ev) => {
        if (ev.type === "text")      writeEvent("text", { text: ev.text });
        else if (ev.type === "thinking") writeEvent("thinking", { text: ev.text });
        else if (ev.type === "rate_limit") writeEvent("rate_limit", ev.info || {});
        else if (ev.type === "done") writeEvent("done", ev.result);
        else if (ev.type === "error") writeEvent("error", { error: ev.error });
      });
      const isCacheHit = result.cache_status === "hit";
      if (!isCacheHit) {
        bumpLlmUsage(caller, result.logical_model, result.usage.total_tokens, result.latency_ms);
        writeInfluxLines([
          `llm_call,caller=${escTagValue(caller)},model=${escTagValue(result.logical_model)},provider=${escTagValue(result.provider)} `
          + `input_tokens=${result.usage.input_tokens}i,`
          + `cache_creation_tokens=${result.usage.cache_creation_input_tokens}i,`
          + `cache_read_tokens=${result.usage.cache_read_input_tokens}i,`
          + `output_tokens=${result.usage.output_tokens}i,`
          + `total_tokens=${result.usage.total_tokens}i,`
          + `latency_ms=${result.latency_ms}i,`
          + `raw_cost_usd=${result.raw_cost_usd || 0},`
          + `shadow_cost_usd=${result.shadow_cost?.estimated_usd || 0}`
          + ` ${BigInt(Date.now()) * 1_000_000n}`
        ]).catch(() => {});
      }
      auditEvent("llm.call", {
        target: caller,
        model: result.logical_model || parsed.model || "?",
        provider: result.provider,
      }, `LLM ${result.logical_model} ← ${caller} (stream${isCacheHit ? "/cache" : ""}, ${result.usage.total_tokens}t, ${result.latency_ms}ms${result.fallback ? `, FALLBACK: ${result.fallback.from}→${result.fallback.to}` : ""})`).catch(() => {});
      // For stream callers: emit the plan_usage_hint as a final SSE event so
      // they can decide whether to back off on the NEXT call.
      try {
        const hint = buildPlanUsageHint(planUsageCache?.data);
        if (hint) writeEvent("plan_usage_hint", hint);
      } catch { /* hint is best-effort */ }
      if (!closed) res.end();
    } catch (e) {
      writeEvent("error", { error: String(e.message) });
      auditEvent("llm.call.fail", { target: caller, model: parsed.model || "?" }, `LLM FAIL stream ${caller}: ${e.message.slice(0, 80)}`).catch(() => {});
      if (!closed) res.end();
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/llm/stats") {
    // Aggregate from InfluxDB llm_call measurement. Returns a tidy structure:
    //   { last_24h: { totals, by_model, by_caller }, last_7d: {...} }
    // Frontend renders this directly into the LLM-Gateway stats block.
    try {
      const target = await resolveInfluxTarget();
      const bucket = target.bucket;
      const buildQ = (range) =>
        `from(bucket:"${bucket}")
          |> range(start:${range})
          |> filter(fn:(r)=>r._measurement=="llm_call")
          |> filter(fn:(r)=>r._field=="total_tokens" or r._field=="output_tokens" or r._field=="raw_cost_usd" or r._field=="shadow_cost_usd" or r._field=="latency_ms")
          |> group(columns:["model","caller","_field"])
          |> sum()`;
      const rollup = (rows) => {
        if (!Array.isArray(rows)) return { error: rows?.error || "no_data", totals: {}, by_model: {}, by_caller: {} };
        const totals = { calls: 0, total_tokens: 0, output_tokens: 0, raw_cost_usd: 0, shadow_cost_usd: 0, avg_latency_ms: 0 };
        const byModel = {};
        const byCaller = {};
        // matrix[caller][model] = { total_tokens, output_tokens, raw_cost_usd, shadow_cost_usd }
        // Built from the SAME (model,caller,_field) grouped rows — the cross product
        // is already in the data, we just keep it instead of collapsing both axes.
        const matrix = {};
        const blankCell = () => ({ total_tokens: 0, output_tokens: 0, raw_cost_usd: 0, shadow_cost_usd: 0 });
        let latencyN = 0;
        for (const r of rows) {
          const field = r._field;
          const value = parseFloat(r._value);
          if (!Number.isFinite(value) || !field) continue;
          const model = r.model || "?";
          const caller = r.caller || "?";
          byModel[model] = byModel[model] || { total_tokens: 0, output_tokens: 0, raw_cost_usd: 0, shadow_cost_usd: 0, calls: 0 };
          byCaller[caller] = byCaller[caller] || { total_tokens: 0, output_tokens: 0, raw_cost_usd: 0, shadow_cost_usd: 0, calls: 0 };
          matrix[caller] = matrix[caller] || {};
          matrix[caller][model] = matrix[caller][model] || blankCell();
          const cell = matrix[caller][model];
          if (field === "total_tokens") {
            totals.total_tokens += value;
            byModel[model].total_tokens += value;
            byCaller[caller].total_tokens += value;
            cell.total_tokens += value;
          } else if (field === "output_tokens") {
            totals.output_tokens += value;
            byModel[model].output_tokens += value;
            byCaller[caller].output_tokens += value;
            cell.output_tokens += value;
            // We use output_tokens as the call counter — each call produces exactly one output_tokens row.
            // (sum() over per-call rows gives the right total tokens, not call count, so count separately.)
          } else if (field === "raw_cost_usd") {
            totals.raw_cost_usd += value;
            byModel[model].raw_cost_usd += value;
            byCaller[caller].raw_cost_usd += value;
            cell.raw_cost_usd += value;
          } else if (field === "shadow_cost_usd") {
            totals.shadow_cost_usd += value;
            byModel[model].shadow_cost_usd += value;
            byCaller[caller].shadow_cost_usd += value;
            cell.shadow_cost_usd += value;
          } else if (field === "latency_ms") {
            totals.avg_latency_ms += value;
            latencyN += 1;
          }
        }
        // Call count = number of distinct latency_ms data points
        totals.calls = latencyN;
        if (latencyN > 0) totals.avg_latency_ms = Math.round(totals.avg_latency_ms / latencyN);
        // by_model/by_caller need call-counts too — derive from output_tokens row count would need raw rows.
        // Cheap heuristic: each call writes one row per field, so number of rows in a group / 4 fields = calls.
        // We don't have that directly here; leave .calls=0 in subgroups for now.
        return { totals, by_model: byModel, by_caller: byCaller, matrix };
      };
      const [r24, r7d] = await Promise.all([
        queryFlux(buildQ("-24h")).catch((e) => ({ error: String(e.message) })),
        queryFlux(buildQ("-7d")).catch((e) => ({ error: String(e.message) })),
      ]);
      return send(200, {
        last_24h: rollup(r24),
        last_7d: rollup(r7d),
        bucket,
        note: "raw_cost_usd is the API-equivalent price the Claude CLI reports; actual billing is against your Pro/Max plan token bucket. shadow_cost_usd is the estimated cost the same call would have had on Anthropic if it ran on an external backend instead (e.g. klick).",
      });
    } catch (e) {
      return send(500, { error: "stats_failed", reason: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agents/create") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    let created;
    try {
      created = await createAgent({ name: parsed.name, mission: parsed.mission });
    } catch (e) {
      const status = e.code === "name_taken" || e.code === "dir_exists" ? 409 : 400;
      auditEvent("agent.create.fail", { target: parsed.name || "?" }, `Create FAIL: ${e.message.slice(0, 80)}`).catch(() => {});
      return send(status, { error: e.code || "create_failed", reason: String(e.message) });
    }
    auditEvent("agent.create", { target: created.name }, `Neuer Agent angelegt: ${created.name}`).catch(() => {});
    // Auto-spawn — failure here is non-fatal; agent is still created and can be spawned manually.
    let spawnResult = null;
    let spawnError = null;
    try {
      spawnResult = await spawnAgent(created.name, created.registry);
      auditEvent("spawn.success", { target: created.name }, `Spawn: ${created.name}`).catch(() => {});
    } catch (e) {
      spawnError = String(e.message);
      auditEvent("spawn.fail", { target: created.name }, `Spawn FAIL ${created.name}: ${e.message.slice(0, 80)}`).catch(() => {});
    }
    broadcastStatus();
    return send(200, {
      ok: true,
      created: created.name,
      cwd: created.cwd,
      spawn: spawnResult,
      spawn_error: spawnError,
    });
  }

  // Reuse-or-spawn escalation: deliver a context message to a peer session,
  // spawning it first if it's offline. Implements Jörg's escalation model
  // ("Session lebt → nutzen, sonst spawnen") for external scripts that can only
  // reach the hub over HTTP (e.g. the pv-inverter anomaly detector on .191).
  if (req.method === "POST" && url.pathname === "/api/peer/notify") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    const repo = parsed.repo;
    if (!repo || typeof repo !== "string") return send(400, { error: "missing_repo" });
    const context = parsed.context;
    if (!context || typeof context !== "string" || !context.trim()) {
      return send(400, { error: "missing_context", hint: "context is the message body delivered to the peer session" });
    }
    const registry = await readRegistry();
    const agent = registry.agents[repo];
    if (!agent) return send(404, { error: "unknown_agent" });

    const reuseIfAlive = parsed.reuse_if_alive !== false;     // default true
    const spawnIfOffline = parsed.spawn_if_offline !== false; // default true
    const source = typeof parsed.source === "string" ? parsed.source.slice(0, 80) : "";
    const body = `📨 [peer/notify via Hulki-Hub${source ? ` · from ${source}` : ""}]\n${context.slice(0, 4000)}`;

    try {
      const peers = await fetchPeers();
      const existing = peers.find((p) => p.cwd === agent.repo);

      // Alive path.
      if (existing) {
        if (!reuseIfAlive) {
          return send(409, { ok: false, delivered: false, action: "alive_no_reuse", peer_id: existing.id });
        }
        await sendChannelMessage(existing.id, body);
        auditEvent("peer.notify", { target: repo, action: "reused", source }, `notify → ${repo} (alive)`).catch(() => {});
        return send(200, { ok: true, delivered: true, action: "reused", peer_id: existing.id });
      }

      // Offline path.
      if (!spawnIfOffline) {
        auditEvent("peer.notify", { target: repo, action: "offline_no_spawn", source }, `notify → ${repo}: offline, spawn disabled`).catch(() => {});
        return send(200, { ok: true, delivered: false, action: "offline_no_spawn" });
      }

      const result = await spawnAgent(repo, registry);
      broadcastStatus();
      if (!result.registered || !result.peer_id) {
        // Spawned but the peer didn't register with the broker in time — caller
        // should retry the notify in a few seconds once the session is up.
        auditEvent("peer.notify", { target: repo, action: "spawned_pending", source }, `notify → ${repo}: spawned, registration pending`).catch(() => {});
        return send(202, { ok: true, delivered: false, action: "spawned_pending", spawn: result, hint: "session spawned but not registered yet; retry notify in ~5s" });
      }
      await sendChannelMessage(result.peer_id, body);
      auditEvent("peer.notify", { target: repo, action: "spawned", source }, `notify → ${repo} (spawned)`).catch(() => {});
      return send(200, { ok: true, delivered: true, action: "spawned", peer_id: result.peer_id, window_id: result.windowId });
    } catch (e) {
      auditEvent("peer.notify.fail", { target: repo, source }, `notify FAIL ${repo}: ${e.message.slice(0, 80)}`).catch(() => {});
      return send(500, { error: "notify_failed", reason: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/spawn") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    if (!parsed.agent) return send(400, { error: "missing_agent" });
    const registry = await readRegistry();
    if (!registry.agents[parsed.agent]) return send(404, { error: "unknown_agent" });
    const peers = await fetchPeers();
    const existing = peers.find((p) => p.cwd === registry.agents[parsed.agent].repo);
    if (existing) return send(200, { already_running: true, peer: existing });
    try {
      const result = await spawnAgent(parsed.agent, registry);
      broadcastStatus();
      auditEvent("spawn.success", { target: parsed.agent }, `Spawn: ${parsed.agent}`).catch(() => {});
      return send(200, { ok: true, ...result });
    } catch (e) {
      auditEvent("spawn.fail", { target: parsed.agent }, `Spawn FAIL ${parsed.agent}: ${e.message.slice(0, 80)}`).catch(() => {});
      return send(500, { error: "spawn_failed", reason: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/focus") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    if (!parsed.agent) return send(400, { error: "missing_agent" });
    const registry = await readRegistry();
    if (!registry.agents[parsed.agent]) return send(404, { error: "unknown_agent" });
    try {
      const result = await focusAgent(parsed.agent, registry);
      return send(result.ok ? 200 : result.not_running ? 409 : 404, result);
    } catch (e) {
      return send(500, { error: "focus_failed", reason: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/recycle") {
    const parsed = (await readBody()) || {};
    if (!parsed.agent) return send(400, { error: "missing_agent" });
    const registry = await readRegistry();
    if (!registry.agents[parsed.agent]) return send(404, { error: "unknown_agent" });
    if (parsed.agent === "agent-master") return send(400, { error: "cannot_recycle_hub", reason: "the Hub can't cleanly stop+respawn itself" });
    // Respond BEFORE recycling — the caller is usually the agent being recycled, so
    // its curl must return before we SIGTERM its session. Recycle runs async.
    send(202, { ok: true, recycling: parsed.agent });
    auditEvent("recycle.start", { target: parsed.agent, requested_by: parsed.requested_by === "agent" ? "agent" : "operator" }, `Recycle start: ${parsed.agent}${parsed.reason ? ` — ${String(parsed.reason).slice(0, 200)}` : ""}`).catch(() => {});
    recycleAgent(parsed.agent, registry)
      .then((r) => auditEvent("recycle.done", { target: parsed.agent }, `Recycle done: ${parsed.agent} respawned=${r.respawned} weiter=${r.weiter_sent}`).catch(() => {}))
      .catch((e) => auditEvent("recycle.fail", { target: parsed.agent }, `Recycle FAIL ${parsed.agent}: ${e.message.slice(0, 120)}`).catch(() => {}));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    if (!parsed.agent) return send(400, { error: "missing_agent" });
    const registry = await readRegistry();
    if (!registry.agents[parsed.agent]) return send(404, { error: "unknown_agent" });
    // requested_by: "agent" when a peer asked to be stopped itself (Hulki policy:
    // agent self-stop requests are ALWAYS honored + logged), "operator" otherwise.
    const requestedBy = parsed.requested_by === "agent" ? "agent" : "operator";
    const stopReason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "";
    try {
      const result = await stopAgent(parsed.agent, registry);
      // If a soft-stop was pending, clear it.
      if (softStopState.has(parsed.agent)) {
        softStopState.delete(parsed.agent);
        persistSoftStopState();
      }
      broadcastStatus();
      auditEvent(
        "stop.success",
        { target: parsed.agent, requested_by: requestedBy },
        `Stop (${requestedBy}): ${parsed.agent}${stopReason ? ` — ${stopReason}` : ""}`,
      ).catch(() => {});
      return send(200, result);
    } catch (e) {
      auditEvent("stop.fail", { target: parsed.agent, requested_by: requestedBy }, `Stop FAIL ${parsed.agent}: ${e.message.slice(0, 80)}`).catch(() => {});
      return send(500, { error: "stop_failed", reason: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/soft-stop") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    if (!parsed.agent) return send(400, { error: "missing_agent" });
    const registry = await readRegistry();
    if (!registry.agents[parsed.agent]) return send(404, { error: "unknown_agent" });
    try {
      const result = await softStopAgent(parsed.agent, registry);
      broadcastStatus();
      auditEvent("soft_stop.start", { target: parsed.agent }, `Soft-Stop angefordert: ${parsed.agent}`).catch(() => {});
      return send(200, result);
    } catch (e) {
      return send(500, { error: "soft_stop_failed", reason: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/soft-stop-extend") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    if (!parsed.agent) return send(400, { error: "missing_agent" });
    try {
      const result = await softStopExtendAgent(parsed.agent);
      broadcastStatus();
      return send(200, result);
    } catch (e) {
      return send(400, { error: "extend_failed", reason: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/soft-stop-cancel") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    if (!parsed.agent) return send(400, { error: "missing_agent" });
    try {
      const result = await softStopCancelAgent(parsed.agent);
      broadcastStatus();
      return send(200, result);
    } catch (e) {
      return send(500, { error: "cancel_failed", reason: String(e.message) });
    }
  }

  return send(404, { error: "not_found", path: url.pathname });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  let filePath = path.join(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR)) return res.writeHead(403).end("forbidden");
  if (!existsSync(filePath)) {
    // SPA deep-link fallback: an extension-less route (e.g. /agent-master, /matrix)
    // that isn't a real file → serve index.html so the client router can handle it.
    if (!path.extname(requested)) {
      filePath = path.join(PUBLIC_DIR, "index.html");
    } else {
      return res.writeHead(404).end("not found");
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  const data = await fs.readFile(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal", reason: String(e.message) }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[agent-master] listening on http://localhost:${PORT}`);
  console.log(`[agent-master] broker: ${BROKER_URL}`);
  console.log(`[agent-master] registry: ${REGISTRY_PATH}`);
  startBriefingLoop().catch((e) => console.warn("[briefing] start failed:", e.message));
  startRegistryFillLoop().catch((e) => console.warn("[registry-fill] start failed:", e.message));
  startSkillUsageLoop().catch((e) => console.warn("[skill-usage] start failed:", e.message));
  startHealthMonitorLoop().catch((e) => console.warn("[health] start failed:", e.message));
  startExternalDiscoveryLoop().catch((e) => console.warn("[discovery] start failed:", e.message));
  // Wire circuit-breaker state changes into the activity feed.
  llmSetAuditSink((event, detail) => auditEvent(event, { target: "llm-gateway" }, detail));
});
