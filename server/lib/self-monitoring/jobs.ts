/**
 * KIOKU™ Self-Monitoring — Internal Jobs Loop
 *
 * Wires internal self-monitoring tasks into the process lifecycle.
 * These jobs are NOT user-facing scheduled tasks — they live purely in-code
 * so KIOKU owns its observability end-to-end (no external cron dependency).
 *
 * Jobs:
 *   - daily health-check         @ 14:00 UTC  → runHealthCheck()
 *   - daily fabrication self-test @ 15:00 UTC → runFabricationSelfTest()
 *
 * Scheduling strategy: a single 60-second tick inspects current UTC time and
 * fires each job at most once per UTC day when its target hour:minute is
 * reached. A tiny in-memory de-dupe keyed on `YYYY-MM-DD:jobId` prevents
 * double-fires if the tick drifts.
 *
 * Registration hook: startSelfMonitoringJobs() is invoked from server/index.ts
 * alongside startScheduler().
 */

import logger from "../../logger";
import { runHealthCheck } from "./health-job";
import { runFabricationSelfTest } from "./fabrication";

const TICK_MS = 60_000;

interface InternalJob {
  id: string;
  /** UTC hour-of-day (0-23) */
  utcHour: number;
  /** UTC minute (0-59) */
  utcMinute: number;
  /** true → disabled (for env gating / tests) */
  disabled?: boolean;
  run: () => Promise<void>;
}

const JOBS: InternalJob[] = [
  {
    id: "health-check-daily",
    utcHour: 14,
    utcMinute: 0,
    async run() {
      const r = await runHealthCheck({ seedIfMissing: true });
      logger.info(
        {
          source: "self-monitoring",
          job: "health-check",
          ok: r.ok,
          drift_count: r.drift_count,
          blocking_drift_count: r.blocking_drift_count,
          baseline_seeded: r.baseline_seeded,
        },
        "[jobs] health-check complete",
      );
    },
  },
  {
    id: "fabrication-self-test-daily",
    utcHour: 15,
    utcMinute: 0,
    async run() {
      const s = await runFabricationSelfTest();
      logger.info(
        {
          source: "self-monitoring",
          job: "fabrication-self-test",
          total: s.total,
          pass: s.pass,
          fail: s.fail,
          error: s.error,
        },
        "[jobs] fabrication-self-test complete",
      );
    },
  },
];

const firedToday = new Set<string>();

function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dueKey(job: InternalJob, d: Date): string {
  return `${utcDayKey(d)}:${job.id}`;
}

async function tick() {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  // Prune entries from older UTC days (keeps Set bounded).
  const today = utcDayKey(now);
  for (const k of firedToday) {
    if (!k.startsWith(`${today}:`)) firedToday.delete(k);
  }

  for (const job of JOBS) {
    if (job.disabled) continue;
    if (hour !== job.utcHour) continue;
    // Fire within the target minute or the following minute (covers tick jitter).
    if (minute !== job.utcMinute && minute !== job.utcMinute + 1) continue;

    const key = dueKey(job, now);
    if (firedToday.has(key)) continue;
    firedToday.add(key);

    logger.info(
      { source: "self-monitoring", job: job.id, utc: `${hour}:${minute}` },
      `[jobs] firing ${job.id}`,
    );
    try {
      await job.run();
    } catch (err: any) {
      logger.error(
        { source: "self-monitoring", job: job.id, err: err?.message },
        `[jobs] ${job.id} threw`,
      );
    }
  }
}

let started = false;

export function startSelfMonitoringJobs(): void {
  if (started) {
    logger.warn("[self-monitoring-jobs] already started — ignoring duplicate call");
    return;
  }
  started = true;
  // Fire tick immediately so startup health verification happens without
  // waiting for the first 60-second boundary; subsequent ticks are intervalled.
  tick().catch((err) =>
    logger.error({ err: err?.message }, "[self-monitoring-jobs] initial tick failed"),
  );
  setInterval(() => {
    tick().catch((err) =>
      logger.error({ err: err?.message }, "[self-monitoring-jobs] tick failed"),
    );
  }, TICK_MS);
  logger.info("[self-monitoring-jobs] started — tick every 60s");
}

// Exposed for tests.
export const __test__ = { JOBS, firedToday, tick };
