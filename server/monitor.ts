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
  lastAlertAt:     number;
  totalChecks:     number;
  totalRecoveries: number;
  startedAt:       string;
}

const state: MonitorState = {
  dbFailCount:     0,
  memFailCount:    0,
  lastAlertAt:     0,
  totalChecks:     0,
  totalRecoveries: 0,
  startedAt:       new Date().toISOString(),
};

export function getMonitorState(): MonitorState { return { ...state }; }

// ── Alert sink ─────────────────────────────────────────────────────────────────
// Future: hook this to Slack/PagerDuty/Resend
function alert(component: string, message: string, severity: "warn" | "critical"): void {
  const now = Date.now();
  // Debounce: max 1 alert per component per 10 min
  if (now - state.lastAlertAt < 10 * 60 * 1000) return;
  state.lastAlertAt = now;

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
    heapUsedMB:  Math.round(mem.heapUsed  / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    heapPct:     Math.round((mem.heapUsed / mem.heapTotal) * 100),
    rssMB:       Math.round(mem.rss       / 1024 / 1024),
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

// ── Start watchdog ────────────────────────────────────────────────────────────
export function startMonitor(): void {
  log("[monitor] watchdog started — interval 60s", "monitor");
  // Run first check after 30s startup grace period
  setTimeout(() => {
    watchdogTick();
    setInterval(watchdogTick, CHECK_INTERVAL_MS);
  }, 30_000);
}
