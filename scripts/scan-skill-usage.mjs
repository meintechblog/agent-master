#!/usr/bin/env node
// Backfill + incremental scanner for Claude Code skill invocations.
//
// Walks ~/.claude/projects/**/*.jsonl, extracts every Skill tool_use block,
// and ships each as a single InfluxDB line-protocol point. Because we re-use
// the record's original timestamp (nanoseconds), running this multiple times
// is idempotent — InfluxDB collapses duplicate (timestamp,tags) writes.
//
// Usage:
//   node scripts/scan-skill-usage.mjs            # full backfill
//   node scripts/scan-skill-usage.mjs --since-ms 600000   # only files modified in last 10 min
//   INFLUX_DRY_RUN=1 node scripts/...           # print line-protocol, don't write
//
// Env:
//   INFLUX_URL    default http://172.25.0.111:8086
//   INFLUX_ORG    default meintechblog
//   INFLUX_BUCKET default default
//   INFLUX_TOKEN  required (no fallback — see ~/.claude/projects/-Users-hulki/memory/project_influxdb_172_25_0_111.md)

import fs from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const HOME = process.env.HOME;
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const INFLUX_URL = process.env.INFLUX_URL || "http://172.25.0.111:8086";
const INFLUX_ORG = process.env.INFLUX_ORG || "meintechblog";
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || "default";
const INFLUX_TOKEN = process.env.INFLUX_TOKEN;
const DRY_RUN = process.env.INFLUX_DRY_RUN === "1";
const BATCH_SIZE = 500;

if (!INFLUX_TOKEN && !DRY_RUN) {
  console.error("missing INFLUX_TOKEN (or set INFLUX_DRY_RUN=1 to test parsing)");
  process.exit(2);
}

// Tag values must not contain ',', ' ', '=' unescaped (InfluxDB line protocol).
function escTag(v) {
  return String(v).replace(/[ ,=]/g, "_");
}

function cwdToProject(cwd) {
  if (!cwd) return "unknown";
  return escTag(path.basename(cwd));
}

async function walkJsonl(rootDir, modifiedSinceMs) {
  const out = [];
  const stack = [rootDir];
  const cutoff = modifiedSinceMs ? Date.now() - modifiedSinceMs : 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile() || !p.endsWith(".jsonl")) continue;
      if (cutoff) {
        try {
          const st = await fs.stat(p);
          if (st.mtimeMs < cutoff) continue;
        } catch { continue; }
      }
      out.push(p);
    }
  }
  return out;
}

async function* extractInvocations(file) {
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (blk?.type !== "tool_use" || blk?.name !== "Skill") continue;
      const sk = blk?.input?.skill;
      if (!sk) continue;
      const ts = rec.timestamp ? new Date(rec.timestamp).getTime() : null;
      if (!ts || Number.isNaN(ts)) continue;
      yield {
        ts_ns: BigInt(ts) * 1_000_000n,
        skill: sk,
        project: cwdToProject(rec.cwd),
        session: (rec.sessionId || "").slice(0, 8) || "unknown",
        branch: escTag(rec.gitBranch || "main"),
      };
    }
  }
}

function pointToLineProtocol(p) {
  // measurement,tag=v,tag=v field=value timestamp_ns
  return `skill_invocations,skill=${escTag(p.skill)},project=${p.project},session=${p.session},branch=${p.branch} count=1i ${p.ts_ns}`;
}

async function writeBatch(lines) {
  if (DRY_RUN) {
    for (const l of lines.slice(0, 3)) console.log("DRY", l);
    if (lines.length > 3) console.log(`DRY (… ${lines.length - 3} more)`);
    return;
  }
  const url = `${INFLUX_URL}/api/v2/write?org=${encodeURIComponent(INFLUX_ORG)}&bucket=${encodeURIComponent(INFLUX_BUCKET)}&precision=ns`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Token ${INFLUX_TOKEN}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: lines.join("\n"),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`influx write ${r.status}: ${body.slice(0, 200)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf("--since-ms");
  const sinceMs = sinceIdx >= 0 ? parseInt(args[sinceIdx + 1], 10) : 0;

  console.log(`[scan] root=${PROJECTS_DIR}  since=${sinceMs ? sinceMs + "ms" : "all-time"}`);
  console.log(`[scan] influx=${DRY_RUN ? "DRY_RUN" : INFLUX_URL + " bucket=" + INFLUX_BUCKET}`);

  const files = await walkJsonl(PROJECTS_DIR, sinceMs);
  console.log(`[scan] ${files.length} transcript files`);

  let pointCount = 0;
  let batch = [];
  const skillSeen = new Map();

  for (const f of files) {
    for await (const p of extractInvocations(f)) {
      batch.push(pointToLineProtocol(p));
      skillSeen.set(p.skill, (skillSeen.get(p.skill) || 0) + 1);
      pointCount++;
      if (batch.length >= BATCH_SIZE) {
        await writeBatch(batch);
        batch = [];
      }
    }
  }
  if (batch.length) await writeBatch(batch);

  console.log(`[scan] wrote ${pointCount} skill invocations across ${skillSeen.size} unique skills`);
  if (skillSeen.size) {
    const top = [...skillSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`[scan] top 10:`);
    for (const [sk, n] of top) console.log(`         ${String(n).padStart(5)}  ${sk}`);
  }
}

main().catch((e) => { console.error("[scan] FAILED:", e.message); process.exit(1); });
