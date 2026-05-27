#!/usr/bin/env node
// agent-master server — localhost:7890
// Aggregiert claude-peers broker + capability registry + spawn/stop + ccusage + SSE.
// LAN-only, no auth. Doku: ~/codex/agent-master/README.md

import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.AGENT_HUB_PORT || "7890", 10);
const BROKER_URL = process.env.CLAUDE_PEERS_BROKER || "http://localhost:7899";
const REGISTRY_PATH = path.join(__dirname, "data", "registry.json");
const REGISTRY_EXAMPLE_PATH = path.join(__dirname, "data", "registry.example.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SPAWN_LOG = path.join(__dirname, "data", "spawn.log");

const USAGE_CACHE_MS = 5 * 60 * 1000;
const HEALTH_CACHE_MS = 60 * 1000;
const BROADCAST_MS = 3000;

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

async function readRegistry() {
  const target = existsSync(REGISTRY_PATH) ? REGISTRY_PATH : REGISTRY_EXAMPLE_PATH;
  return JSON.parse(await fs.readFile(target, "utf8"));
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

async function spawnAgent(repoKey, registry) {
  const agent = registry.agents[repoKey];
  if (!agent) throw new Error(`unknown agent: ${repoKey}`);
  const cwd = agent.repo;
  if (!existsSync(cwd)) throw new Error(`repo dir missing: ${cwd}`);

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

  const script = `
    tell application "Terminal" to activate
    tell application "System Events" to tell process "Terminal" to keystroke "t" using command down
    delay 1
    tell application "Terminal"
      do script "cd ${cwd} && claudepeers" in selected tab of front window
      return id of front window
    end tell
  `;
  const wid = parseInt(await runOsa(script), 10);

  await new Promise((r) => setTimeout(r, 12000));
  const dismiss = `
    tell application "Terminal"
      activate
      set index of window id ${wid} to 1
      set selected of tab 1 of window id ${wid} to true
    end tell
    delay 0.5
    tell application "System Events" to tell process "Terminal" to key code 36
  `;
  await runOsa(dismiss).catch(() => {});

  await fs.appendFile(SPAWN_LOG, `${new Date().toISOString()} spawn ${repoKey} window=${wid}\n`);
  return { repoKey, windowId: wid, cwd };
}

async function stopAgent(repoKey, registry) {
  const agent = registry.agents[repoKey];
  if (!agent) throw new Error(`unknown agent: ${repoKey}`);
  const peers = await fetchPeers();
  const peer = peers.find((p) => p.cwd === agent.repo);
  if (!peer) return { not_running: true, agent: repoKey };

  const ttyShort = (peer.tty || "").replace("/dev/", "");
  let targetWid = null;
  let targetTab = null;
  if (ttyShort) {
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
            if tt is "/dev/${ttyShort}" then
              set found to (wid as text) & ":" & (i as text)
              exit repeat
            end if
          end repeat
          if found is not "" then exit repeat
        end repeat
        return found
      end tell
    `;
    const result = await runOsa(findScript).catch(() => "");
    if (result) {
      const [w, t] = result.split(":");
      targetWid = parseInt(w, 10);
      targetTab = parseInt(t, 10);
    }
  }

  let signaled = false;
  if (peer.pid) {
    try {
      process.kill(peer.pid, "SIGTERM");
      signaled = true;
    } catch {}
  }

  await new Promise((r) => setTimeout(r, 1500));
  let tabClosed = false;
  if (targetWid && targetTab) {
    const closeScript = `
      tell application "Terminal"
        try
          close tab ${targetTab} of window id ${targetWid}
        on error
          try
            close window id ${targetWid}
          end try
        end try
      end tell
    `;
    await runOsa(closeScript).catch(() => {});
    tabClosed = true;
  }

  await fs.appendFile(SPAWN_LOG, `${new Date().toISOString()} stop  ${repoKey} pid=${peer.pid} tty=${peer.tty} signaled=${signaled} tab=${tabClosed}\n`);
  return { ok: true, agent: repoKey, signaled, tab_closed: tabClosed, peer_id: peer.id };
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
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 3000);
        const fetchOpts = { method: hc.method || "GET", signal: ctrl.signal };
        if (fetchOpts.method === "POST") {
          fetchOpts.headers = { "Content-Type": "application/json" };
          fetchOpts.body = "{}";
        }
        const r = await fetch(hc.url, fetchOpts);
        clearTimeout(to);
        const expected = hc.expected_status || 200;
        return [key, { status: r.status === expected ? "ok" : "warn", http_status: r.status, expected }];
      } catch (e) {
        return [key, { status: "down", reason: String(e.message).slice(0, 100) }];
      }
    })
  );
  const data = { checks: Object.fromEntries(checks), generated_at: new Date().toISOString() };
  healthCache = { data, fetched_at: now };
  return { ...data, cached: false, age_ms: 0 };
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
      };
    }
    const payload = {
      agents,
      online_count: peers.length,
      total_count: Object.keys(registry.agents).length,
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

setInterval(broadcastStatus, BROADCAST_MS);
setInterval(broadcastUsage, USAGE_CACHE_MS);

async function handleApi(req, res, url) {
  const send = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj, null, 2));
  };

  if (req.method === "GET" && url.pathname === "/api/registry") return send(200, await readRegistry());

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
      };
    }
    return send(200, {
      agents,
      online_count: peers.length,
      total_count: Object.keys(registry.agents).length,
      updated_at: new Date().toISOString(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    return send(200, await fetchUsage(url.searchParams.get("refresh") === "1"));
  }

  if (req.method === "GET" && url.pathname === "/api/plan-usage") {
    return send(200, await fetchPlanUsage(url.searchParams.get("refresh") === "1"));
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const registry = await readRegistry();
    return send(200, await fetchHealth(registry, url.searchParams.get("refresh") === "1"));
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
      return send(200, { ok: true, ...result });
    } catch (e) {
      return send(500, { error: "spawn_failed", reason: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const parsed = await readJson();
    if (!parsed) return send(400, { error: "invalid_json" });
    if (!parsed.agent) return send(400, { error: "missing_agent" });
    const registry = await readRegistry();
    if (!registry.agents[parsed.agent]) return send(404, { error: "unknown_agent" });
    try {
      const result = await stopAgent(parsed.agent, registry);
      broadcastStatus();
      return send(200, result);
    } catch (e) {
      return send(500, { error: "stop_failed", reason: String(e.message) });
    }
  }

  return send(404, { error: "not_found", path: url.pathname });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR)) return res.writeHead(403).end("forbidden");
  if (!existsSync(filePath)) return res.writeHead(404).end("not found");
  const ext = path.extname(filePath).toLowerCase();
  const data = await fs.readFile(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
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
});
