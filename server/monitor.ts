/**
 * KIOKU™ Internal Watchdog & Auto-Recovery
 * Runs periodic health checks and attempts self-healing where possible.
 *
 * Recovery actions:
 *   - DB down → attempt pool reconnect (pg pool auto-reconnects on next query)
 *   - Memory critical → trigger GC if available
 *   - Consecutive failures → log alert (hook for future PagerDuty/Slack)
 */

import { pool } from "./storage";
import { getOpenAIBreakerState } from "./lib/openai-client";
import { getAgentBreakerSummary } from "./lib/openai-per-agent-breaker";

function log(msg: string, source = "monitor") {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [${source}] ${msg}`);
}

// ── Config ────────────────────────────────────────────────────────────────────
const CHECK_INTERVAL_MS   = 60_000;  // run checks every 60s
const ALERT_AFTER_FAILS   = 3;       // alert after N consecutive failures
const DB_RECONNECT_DELAY  = 5_000;   // wait 5s before DB reconnect attempt

// ── State ─────────────────────────────────────────────────────────────────────
interface MonitorState {
  dbFailCount:     number;
  memFailCount:    number;
  /** R3: per-component debounce — keyed by component name ("database", "memory", "migrations") */
  lastAlertAt:     Record<string, number>;
  /** Item 2: count of stale (crashed-mid-run) migrations detected */
  staleMigrations: number;
  totalChecks:     number;
  totalRecoveries: number;
  startedAt:       string;
}

const state: MonitorState = {
  dbFailCount:     0,
  memFailCount:    0,
  lastAlertAt:     {},  // R3: per-component, initially empty
  staleMigrations: 0,
  totalChecks:     0,
  totalRecoveries: 0,
  startedAt:       new Date().toISOString(),
};

export function getMonitorState(): MonitorState { return { ...state }; }

// ── Alert sink ─────────────────────────────────────────────────────────────────
// Future: hook this to Slack/PagerDuty/Resend
function alert(component: string, message: string, severity: "warn" | "critical"): void {
  const now = Date.now();
  // R3: per-component debounce — each component has its own 10-min cooldown
  // Previously this was a single global lastAlertAt which caused DB alerts to
  // silence migration alerts for 10 min. Fixed: keyed by component.
  const last = state.lastAlertAt[component] || 0;
  if (now - last < 10 * 60 * 1000) return;
  state.lastAlertAt[component] = now;

  const prefix = severity === "critical" ? "🔴 CRITICAL" : "🟡 WARN";
  console.error(`[monitor] ${prefix} [${component}] ${message}`);

  // TODO: send Resend alert email to kote@ikonbai.com when RESEND_API_KEY is active
  // sendAlertEmail(component, message, severity);
}

// ── DB Recovery ───────────────────────────────────────────────────────────────
async function attemptDbRecovery(): Promise<boolean> {
  try {
    log("[monitor] attempting DB reconnect…", "monitor");
    await new Promise(r => setTimeout(r, DB_RECONNECT_DELAY));
    // pg pool reconnects automatically — just ping it
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    state.dbFailCount = 0;
    state.totalRecoveries += 1;
    log("[monitor] DB recovery SUCCESS", "monitor");
    return true;
  } catch (err: any) {
    log(`[monitor] DB recovery FAILED: ${err.message}`, "monitor");
    return false;
  }
}

// ── Memory Recovery ───────────────────────────────────────────────────────────
function attemptMemoryRecovery(): void {
  // @ts-ignore — gc() available in Node when started with --expose-gc
  if (typeof gc === "function") {
    // @ts-ignore
    gc();
    log("[monitor] forced GC run", "monitor");
    state.totalRecoveries += 1;
  } else {
    log("[monitor] GC not exposed — consider --expose-gc flag", "monitor");
  }
}

// ── Main watchdog tick ────────────────────────────────────────────────────────
async function watchdogTick(): Promise<void> {
  state.totalChecks += 1;

  // ── 1. Database ──────────────────────────────────────────────────────────────
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    if (state.dbFailCount > 0) {
      log(`[monitor] DB back online after ${state.dbFailCount} failures`, "monitor");
    }
    state.dbFailCount = 0;
  } catch (err: any) {
    state.dbFailCount += 1;
    log(`[monitor] DB check failed (x${state.dbFailCount}): ${err.message}`, "monitor");

    if (state.dbFailCount >= ALERT_AFTER_FAILS) {
      alert("database", `DB unreachable for ${state.dbFailCount} consecutive checks`, "critical");
      await attemptDbRecovery();
    }
  }

  // ── 2. Memory ────────────────────────────────────────────────────────────────
  const mem = process.memoryUsage();
  const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);

  if (heapPct > 95) {
    state.memFailCount += 1;
    log(`[monitor] CRITICAL memory: ${heapPct}% heap used`, "monitor");
    alert("memory", `Heap at ${heapPct}% — approaching OOM`, "critical");
    attemptMemoryRecovery();
  } else if (heapPct > 80) {
    log(`[monitor] WARN memory: ${heapPct}% heap used`, "monitor");
    if (state.memFailCount >= ALERT_AFTER_FAILS) {
      alert("memory", `Heap at ${heapPct}% for ${state.memFailCount} checks`, "warn");
    }
    state.memFailCount += 1;
  } else {
    state.memFailCount = 0;
  }

  // ── 3. Rate limit map cleanup ─────────────────────────────────────────────
  // Covered by ratelimit.ts interval — no action needed here

  // ── 4. Log tick summary (only on issues) ─────────────────────────────────
  if (state.dbFailCount > 0 || heapPct > 80) {
    log(
      `[monitor] tick #${state.totalChecks} | db_fails=${state.dbFailCount} heap=${heapPct}% recoveries=${state.totalRecoveries}`,
      "monitor"
    );
  }
}

// ── Expose monitor status endpoint data ──────────────────────────────────────
export function getMonitorSummary() {
  const mem = process.memoryUsage();
  return {
    ...getMonitorState(),
    heapUsedMB:      Math.round(mem.heapUsed  / 1024 / 1024),
    heapTotalMB:     Math.round(mem.heapTotal / 1024 / 1024),
    heapPct:         Math.round((mem.heapUsed / mem.heapTotal) * 100),
    rssMB:           Math.round(mem.rss       / 1024 / 1024),
    uptimeSeconds:   Math.floor(process.uptime()),
    staleMigrations: state.staleMigrations,  // Item 2: expose in /health/monitor output
    openaiBreaker:   getOpenAIBreakerState(), // W5 Item 1 / R3 Q8: ops visibility
    agentBreakers:   getAgentBreakerSummary(), // W6 1b: per-agent breaker summary
  };
}

// ── Stale migration check ──────────────────────────────────────────────────────
async function checkStaleMigrations(): Promise<void> {
  try {
    const { rows } = await pool.query<{ version: string; applied_at: Date }>(
      `SELECT version, applied_at FROM schema_migrations
       WHERE duration_ms = 0 AND applied_at < NOW() - INTERVAL '1 hour'
       ORDER BY applied_at ASC`
    );
    state.staleMigrations = rows.length;
    if (rows.length > 0) {
      alert(
        "migrations",
        `${rows.length} stale migration(s): ${rows.map((r) => r.version).join(", ")}`,
        "critical"
      );
    }
  } catch (err: any) {
    // Don't alert if DB itself is down — that\'s a separate component alert
    log(`stale migration check failed: ${err.message}`);
  }
}

// ── Start watchdog ────────────────────────────────────────────
export function startMonitor(): void {
  log("[monitor] watchdog started — interval 60s", "monitor");
  // Run first check after 30s startup grace period
  setTimeout(() => {
    watchdogTick();
    // Item 2: also check for stale migrations on each periodic tick
    void checkStaleMigrations();
    setInterval(() => {
      watchdogTick();
      void checkStaleMigrations();
    }, CHECK_INTERVAL_MS);
  }, 30_000);
}

// Item 2: also export for tests
export { checkStaleMigrations };

/**
 * Test-only: reset per-component debounce state so tests don't interfere.
 * Not for production use.
 */
export function __resetMonitorStateForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetMonitorStateForTest is test-only");
  }
  state.lastAlertAt = {};
  state.staleMigrations = 0;
  state.dbFailCount = 0;
  state.memFailCount = 0;
  state.totalChecks = 0;
  state.totalRecoveries = 0;
}
