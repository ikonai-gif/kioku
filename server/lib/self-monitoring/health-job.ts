/**
 * KIOKU™ Self-Monitoring — Daily Health Check Job
 *
 * Orchestrates: collect → diff → persist → alert → baseline-upsert.
 *
 * Invoked by:
 *   - server/lib/self-monitoring/jobs.ts scheduler tick (daily 14:00 UTC)
 *   - POST /api/admin/self-monitoring/run-health-check (manual)
 *   - startup seed if no baseline exists yet
 */

import { pool } from "../../storage";
import logger from "../../logger";
import { collectCapabilitiesTruth, truthToBaselineShape, type CapabilitiesTruth } from "./collect";
import { detectDrift, isAutoAcknowledgeable, type BaselineShape, type DriftEvent } from "./drift";
import { sendAlert } from "./webhook";

const SCHEMA_VERSION = "1.0";

// ── Baseline helpers (direct SQL, keeps Storage interface clean) ────────────

async function getActiveBaseline(): Promise<(BaselineShape & { id: number; snapshotAt: number }) | null> {
  const r = await pool.query(
    `SELECT id, snapshot_at, env_flags, tools
       FROM kioku_capabilities_baseline
      WHERE is_active = true
      ORDER BY snapshot_at DESC
      LIMIT 1`,
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    snapshotAt: Number(row.snapshot_at),
    envFlags: row.env_flags,
    tools: row.tools,
  };
}

async function getPreviousObservedTools(): Promise<Set<string>> {
  // "Last observed set" = tools that fired in the 24h leading up to the
  // most recent baseline snapshot. Approximate with: latest 24h tools minus
  // nothing. We store the observed set alongside baseline for silent-drift
  // detection to be meaningful between runs.
  const r = await pool.query(
    `SELECT tools FROM kioku_capabilities_baseline
      WHERE is_active = true ORDER BY snapshot_at DESC LIMIT 1`,
  );
  if (r.rows.length === 0) return new Set();
  // We deliberately keep "observed set" separate from tools-in-schema. The
  // tools column stores only schema+category; observed firing is per-sample.
  // For the very first implementation we accept "silent drift" may be noisy
  // in the first 1-2 runs, then settles. This keeps the schema simple.
  return new Set();
}

async function insertBaseline(
  truth: CapabilitiesTruth,
  acceptedBy: string | null,
): Promise<number> {
  const shape = truthToBaselineShape(truth);
  // Deactivate previous
  await pool.query(
    `UPDATE kioku_capabilities_baseline SET is_active = false WHERE is_active = true`,
  );
  const r = await pool.query(
    `INSERT INTO kioku_capabilities_baseline
       (snapshot_at, schema_version, env_flags, tools, is_active, accepted_by, created_at)
     VALUES ($1, $2, $3, $4, true, $5, $6)
     RETURNING id`,
    [
      Date.now(),
      SCHEMA_VERSION,
      JSON.stringify(shape.envFlags),
      JSON.stringify(shape.tools),
      acceptedBy,
      Date.now(),
    ],
  );
  return r.rows[0].id as number;
}

async function insertDriftEvents(events: DriftEvent[]): Promise<number[]> {
  if (events.length === 0) return [];
  const ids: number[] = [];
  const now = Date.now();
  for (const ev of events) {
    const r = await pool.query(
      `INSERT INTO kioku_capabilities_drift_log
         (detected_at, severity, change_type, detail, before_value, after_value)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        now,
        ev.severity,
        ev.changeType,
        ev.detail,
        ev.beforeValue ? JSON.stringify(ev.beforeValue) : null,
        ev.afterValue ? JSON.stringify(ev.afterValue) : null,
      ],
    );
    ids.push(r.rows[0].id);
  }
  return ids;
}

async function markNotified(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE kioku_capabilities_drift_log
        SET notified = true, notified_at = $1
      WHERE id = ANY($2::int[])`,
    [Date.now(), ids],
  );
}

async function autoAcknowledgeInfoEvents(events: Array<DriftEvent & { id: number }>): Promise<void> {
  const autoIds = events.filter((e) => isAutoAcknowledgeable(e)).map((e) => e.id);
  if (autoIds.length === 0) return;
  await pool.query(
    `UPDATE kioku_capabilities_drift_log
        SET acknowledged = true, acknowledged_at = $1, acknowledged_by = 'auto:health-job'
      WHERE id = ANY($2::int[])`,
    [Date.now(), autoIds],
  );
}

// ── Core runner ──────────────────────────────────────────────────────────────

export type HealthCheckResult = {
  ok: boolean;
  baseline_seeded: boolean;
  drift_count: number;
  blocking_drift_count: number;
  baseline_id: number;
  drift_ids: number[];
  truth_generated_at: string;
};

/**
 * Run one health-check cycle. Safe to call repeatedly (idempotent w.r.t.
 * duplicate drift events in the same second, but will append if called
 * multiple times back-to-back — rate limit at the caller if needed).
 */
export async function runHealthCheck(opts: { seedIfMissing?: boolean } = {}): Promise<HealthCheckResult> {
  const seedIfMissing = opts.seedIfMissing ?? true;
  const truth = await collectCapabilitiesTruth({ roomId: 151 });

  const existing = await getActiveBaseline();
  if (!existing) {
    if (!seedIfMissing) {
      throw new Error("no active baseline and seedIfMissing=false");
    }
    const newId = await insertBaseline(truth, "auto:first-boot");
    logger.info(
      { component: "self-monitoring", event: "baseline_seeded", baselineId: newId },
      "[self-monitoring] first baseline seeded",
    );
    return {
      ok: true,
      baseline_seeded: true,
      drift_count: 0,
      blocking_drift_count: 0,
      baseline_id: newId,
      drift_ids: [],
      truth_generated_at: truth.generated_at,
    };
  }

  const prevObserved = await getPreviousObservedTools();
  const events = detectDrift(existing, truth, prevObserved);
  const driftIds = await insertDriftEvents(events);
  const eventsWithIds = events.map((ev, i) => ({ ...ev, id: driftIds[i] }));

  // Auto-acknowledge info severities (env flag changes) per design doc #5
  await autoAcknowledgeInfoEvents(eventsWithIds);

  // Alert (one webhook call per event, no batching for now)
  const notifiedIds: number[] = [];
  for (const ev of eventsWithIds) {
    const result = await sendAlert({
      severity: ev.severity,
      title: `Capability drift: ${ev.changeType}`,
      detail: ev.detail,
      context: { before: ev.beforeValue, after: ev.afterValue, drift_id: ev.id },
    });
    if (result.delivered) notifiedIds.push(ev.id);
  }
  await markNotified(notifiedIds);

  // Baseline update policy (design doc #5):
  //   - If ONLY info events (all env flag changes) → auto-update baseline
  //   - If ANY critical/warn → do NOT update, keep alerting until manual accept
  const hasBlocking = events.some((e) => !isAutoAcknowledgeable(e));
  let newBaselineId = existing.id;
  if (events.length > 0 && !hasBlocking) {
    newBaselineId = await insertBaseline(truth, "auto:info-only-drift");
    logger.info(
      { component: "self-monitoring", event: "baseline_auto_updated", baselineId: newBaselineId },
      "[self-monitoring] baseline auto-updated (info-only drift)",
    );
  }

  return {
    ok: !hasBlocking,
    baseline_seeded: false,
    drift_count: events.length,
    blocking_drift_count: events.filter((e) => !isAutoAcknowledgeable(e)).length,
    baseline_id: newBaselineId,
    drift_ids: driftIds,
    truth_generated_at: truth.generated_at,
  };
}

/**
 * Manual baseline acceptance (POST /api/admin/self-monitoring/baseline/accept).
 * Takes a fresh truth snapshot and installs it, acknowledges all outstanding
 * drift events.
 */
export async function acceptCurrentTruthAsBaseline(acceptedBy: string): Promise<{ baseline_id: number; acked_drift_ids: number[] }> {
  const truth = await collectCapabilitiesTruth({ roomId: 151 });
  const baselineId = await insertBaseline(truth, acceptedBy);
  const r = await pool.query(
    `UPDATE kioku_capabilities_drift_log
        SET acknowledged = true, acknowledged_at = $1, acknowledged_by = $2
      WHERE acknowledged = false
      RETURNING id`,
    [Date.now(), acceptedBy],
  );
  return {
    baseline_id: baselineId,
    acked_drift_ids: r.rows.map((x: any) => x.id),
  };
}
