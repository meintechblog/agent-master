// LLM-Gateway response cache.
//
// Why: peers run periodic status calls (energy-master polls every 60s) where
// the prompt is byte-identical for minutes at a time. We don't want to burn
// plan quota on each repeat. SHA256-keyed in-memory cache with TTL.
//
// Scope: process-local Map — caches persist for the LaunchAgent lifetime
// (typically hours/days) but disappear on restart. That's intentional: a
// dumb cache is easier to reason about than a persistent one, and the
// keep-warm cost of regenerating an entry after restart is acceptable.
//
// Default TTL: 5 minutes. Override per-call via `cache_ttl_ms`.

import { createHash } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;  // soft cap — lazy eviction when we exceed

const store = new Map();  // key → { result, expires_at, cached_at, hits }

let stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

/**
 * Build a stable cache key from request shape. Order-sensitive on prompt+system
 * but field-order-independent (we always join in the same order here).
 */
export function cacheKey({ model, system, prompt, json_schema, max_tokens }) {
  const h = createHash("sha256");
  h.update(`m=${model || ""}\n`);
  h.update(`s=${system || ""}\n`);
  h.update(`p=${prompt || ""}\n`);
  h.update(`mt=${max_tokens ?? ""}\n`);
  if (json_schema) {
    // Sort keys recursively so {a:1,b:2} and {b:2,a:1} hash the same.
    h.update(`js=${JSON.stringify(canonicalize(json_schema))}\n`);
  }
  return h.digest("hex");
}

function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}

/**
 * Returns cached result or null. Lazy-evicts expired on read.
 */
export function getCached(key) {
  const entry = store.get(key);
  if (!entry) {
    stats.misses += 1;
    return null;
  }
  if (Date.now() > entry.expires_at) {
    store.delete(key);
    stats.evictions += 1;
    stats.misses += 1;
    return null;
  }
  entry.hits += 1;
  stats.hits += 1;
  return entry.result;
}

/**
 * Store a result with TTL. Evicts oldest entry if over capacity.
 */
export function setCached(key, result, ttlMs = DEFAULT_TTL_MS) {
  if (ttlMs <= 0) return;
  if (store.size >= MAX_ENTRIES) {
    // Cheap eviction: drop the entry with the earliest expires_at.
    let oldestKey = null;
    let oldestExpires = Infinity;
    for (const [k, v] of store) {
      if (v.expires_at < oldestExpires) {
        oldestExpires = v.expires_at;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      store.delete(oldestKey);
      stats.evictions += 1;
    }
  }
  store.set(key, {
    result,
    expires_at: Date.now() + ttlMs,
    cached_at: Date.now(),
    hits: 0,
  });
  stats.sets += 1;
}

export function getStats() {
  return {
    ...stats,
    size: store.size,
    max_entries: MAX_ENTRIES,
    default_ttl_ms: DEFAULT_TTL_MS,
  };
}

export function clearCache() {
  const n = store.size;
  store.clear();
  return { cleared: n };
}

export const DEFAULTS = { DEFAULT_TTL_MS, MAX_ENTRIES };
