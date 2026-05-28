// Circuit breaker for external LLM backends.
//
// Why: when klick goes down, blindly retrying with a 60s timeout means each
// of the next N calls wastes 60s before falling back. After 3 fails we KNOW
// the backend is down — stop punishing every caller for the same diagnosis.
//
// State machine, per backend name (klick, future others):
//
//   CLOSED ── 3 consecutive fails in 60s ──▶ OPEN
//   OPEN ── 30s elapsed ──▶ HALF_OPEN
//   HALF_OPEN ── 1 probe success ──▶ CLOSED
//   HALF_OPEN ── 1 probe fail ──▶ OPEN  (reset 30s cooldown)
//
// While OPEN: shouldAllow() returns false → caller falls back immediately
// without ever touching the failed backend.
//
// Methodology follows Hystrix / resilience4j conventions (the half-open
// "single probe" pattern). Per-process state — no persistence; on restart
// every backend is assumed healthy again, which is correct (a restart is
// a strong signal that operator wants to retest).

const FAIL_THRESHOLD = 3;
const FAIL_WINDOW_MS = 60_000;
const OPEN_COOLDOWN_MS = 30_000;

const breakers = new Map();  // backendName → { state, fail_times, opened_at, last_change_at }

function ensure(backendName) {
  let b = breakers.get(backendName);
  if (!b) {
    b = {
      state: "closed",
      fail_times: [],
      opened_at: null,
      last_change_at: Date.now(),
      total_opens: 0,
      total_fallbacks_while_open: 0,
    };
    breakers.set(backendName, b);
  }
  return b;
}

/**
 * Returns true if the backend should be tried. False means caller MUST fall
 * back without a network call. Also implicitly transitions OPEN → HALF_OPEN
 * when the cooldown has elapsed.
 *
 * @param {string} backendName
 * @returns {{allow: boolean, state: string, reason?: string}}
 */
export function shouldAllow(backendName) {
  const b = ensure(backendName);
  const now = Date.now();
  if (b.state === "closed") return { allow: true, state: "closed" };
  if (b.state === "open") {
    if (now - b.opened_at >= OPEN_COOLDOWN_MS) {
      // Transition to half-open — one probe call is allowed.
      b.state = "half_open";
      b.last_change_at = now;
      return { allow: true, state: "half_open", reason: "cooldown elapsed, probing" };
    }
    b.total_fallbacks_while_open += 1;
    return {
      allow: false,
      state: "open",
      reason: `open for ${Math.round((now - b.opened_at) / 1000)}s, cooldown ${Math.round((OPEN_COOLDOWN_MS - (now - b.opened_at)) / 1000)}s remaining`,
    };
  }
  // half_open: only one call at a time should be allowed through. We don't
  // currently lock concurrent half-open probes; in our load profile (<10
  // calls/min) the race is acceptable. If we ever hit higher concurrency we
  // can add an inflight flag here.
  return { allow: true, state: "half_open" };
}

/**
 * Record the outcome of a call. Transitions the breaker state.
 *
 * @param {string} backendName
 * @param {boolean} success
 * @param {(event: string, detail: string) => Promise<void>} [auditFn]
 *        Optional audit-event sink. The server passes auditEvent() so state
 *        changes show up in the activity feed.
 */
export async function recordResult(backendName, success, auditFn) {
  const b = ensure(backendName);
  const now = Date.now();
  if (success) {
    if (b.state === "half_open") {
      // Probe succeeded — close the circuit.
      b.state = "closed";
      b.fail_times = [];
      b.opened_at = null;
      b.last_change_at = now;
      if (auditFn) await auditFn("circuit.closed", `${backendName}: probe succeeded, circuit closed`);
    } else if (b.state === "closed") {
      // Healthy call — trim old failures from the window so a sporadic flake
      // an hour ago doesn't combine with two now to trip the breaker.
      b.fail_times = b.fail_times.filter((t) => now - t < FAIL_WINDOW_MS);
    }
    return;
  }
  // Failure path.
  if (b.state === "half_open") {
    // Probe failed — reopen with fresh cooldown.
    b.state = "open";
    b.opened_at = now;
    b.last_change_at = now;
    b.total_opens += 1;
    if (auditFn) await auditFn("circuit.opened", `${backendName}: half-open probe failed, circuit reopened for ${OPEN_COOLDOWN_MS / 1000}s`);
    return;
  }
  if (b.state === "open") {
    // Already open and somehow a call got through (race) — ignore for state,
    // just refresh the cooldown timestamp so we don't probe too eagerly.
    b.opened_at = now;
    return;
  }
  // state === "closed": count the failure.
  b.fail_times.push(now);
  b.fail_times = b.fail_times.filter((t) => now - t < FAIL_WINDOW_MS);
  if (b.fail_times.length >= FAIL_THRESHOLD) {
    b.state = "open";
    b.opened_at = now;
    b.last_change_at = now;
    b.total_opens += 1;
    if (auditFn) await auditFn("circuit.opened", `${backendName}: ${FAIL_THRESHOLD} fails in ${FAIL_WINDOW_MS / 1000}s, circuit opened for ${OPEN_COOLDOWN_MS / 1000}s`);
  }
}

/**
 * Snapshot of all breakers for /api/llm/circuits and UI display.
 */
export function getCircuitStats() {
  const out = {};
  for (const [name, b] of breakers) {
    out[name] = {
      state: b.state,
      fails_in_window: b.fail_times.length,
      fail_window_ms: FAIL_WINDOW_MS,
      fail_threshold: FAIL_THRESHOLD,
      opened_at: b.opened_at,
      open_cooldown_ms: OPEN_COOLDOWN_MS,
      cooldown_remaining_ms: b.state === "open" && b.opened_at
        ? Math.max(0, OPEN_COOLDOWN_MS - (Date.now() - b.opened_at))
        : 0,
      last_change_at: b.last_change_at,
      total_opens: b.total_opens,
      total_fallbacks_while_open: b.total_fallbacks_while_open,
    };
  }
  return out;
}

/**
 * Force-close a circuit (operator override, e.g. after a known fix).
 */
export function forceClose(backendName) {
  const b = breakers.get(backendName);
  if (!b) return false;
  b.state = "closed";
  b.fail_times = [];
  b.opened_at = null;
  b.last_change_at = Date.now();
  return true;
}

/**
 * Force-open a circuit (operator override, e.g. take backend offline
 * intentionally for maintenance).
 */
export function forceOpen(backendName) {
  const b = ensure(backendName);
  b.state = "open";
  b.opened_at = Date.now();
  b.last_change_at = Date.now();
  return true;
}

export const CONSTANTS = { FAIL_THRESHOLD, FAIL_WINDOW_MS, OPEN_COOLDOWN_MS };
