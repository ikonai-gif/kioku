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

type ClientLike = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
};

async function getActiveBaseline(
  client: ClientLike = pool,
): Promise<(BaselineShape & { id: number; snapshotAt: number; observedFiring: Set<string> }) | null> {
  const r = await client.query(
    `SELECT id, snapshot_at, env_flags, tools, observed_firing
       FROM kioku_capabilities_baseline
      WHERE is_active = true
      ORDER BY snapshot_at DESC
      LIMIT 1`,
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  // observed_firing column (migration 0008) may be missing in unmigrated dev DBs.
  // Fall back to empty set — caller will still function, just won't detect silent
  // regression on the first post-migration run.
  const observedRaw = Array.isArray(row.observed_firing) ? row.observed_firing : [];
  return {
    id: row.id,
    snapshotAt: Number(row.snapshot_at),
    envFlags: row.env_flags,
    tools: row.tools,
    observedFiring: new Set(observedRaw.map((x: any) => String(x))),
  };
}

async function insertBaseline(
  truth: CapabilitiesTruth,
  acceptedBy: string | null,
  client: ClientLike = pool,
): Promise<number> {
  const shape = truthToBaselineShape(truth);
  const observedFiring = truth.observed_firing_24h.map((o) => o.tool);
  // Deactivate previous
  await client.query(
    `UPDATE kioku_capabilities_baseline SET is_active = false WHERE is_active = true`,
  );
  const r = await client.query(
    `INSERT INTO kioku_capabilities_baseline
       (snapshot_at, schema_version, env_flags, tools, observed_firing, is_active, accepted_by, created_at)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7)
     RETURNING id`,
    [
      Date.now(),
      SCHEMA_VERSION,
      JSON.stringify(shape.envFlags),
      JSON.stringify(shape.tools),
      JSON.stringify(observedFiring),
      acceptedBy,
      Date.now(),
    ],
  );
  return r.rows[0].id as number;
}

async function insertDriftEvents(
  events: DriftEvent[],
  client: ClientLike = pool,
): Promise<number[]> {
  if (events.length === 0) return [];
  const now = Date.now();
  // M-6: atomic batch insert via UNNEST. One round trip, one transactional step.
  const detectedAtArr: number[] = [];
  const severityArr: string[] = [];
  const changeTypeArr: string[] = [];
  const detailArr: (string | null)[] = [];
  const beforeArr: (string | null)[] = [];
  const afterArr: (string | null)[] = [];
  for (const ev of events) {
    detectedAtArr.push(now);
    severityArr.push(ev.severity);
    changeTypeArr.push(ev.changeType);
    detailArr.push(ev.detail ?? null);
    beforeArr.push(ev.beforeValue != null ? JSON.stringify(ev.beforeValue) : null);
    afterArr.push(ev.afterValue != null ? JSON.stringify(ev.afterValue) : null);
  }
  const r = await client.query(
    `INSERT INTO kioku_capabilities_drift_log
       (detected_at, severity, change_type, detail, before_value, after_value)
     SELECT * FROM UNNEST(
       $1::bigint[], $2::text[], $3::text[], $4::text[], $5::jsonb[], $6::jsonb[]
     )
     RETURNING id`,
    [detectedAtArr, severityArr, changeTypeArr, detailArr, beforeArr, afterArr],
  );
  return r.rows.map((x: any) => Number(x.id));
}

async function markNotified(ids: number[], client: ClientLike = pool): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE kioku_capabilities_drift_log
        SET notified = true, notified_at = $1
      WHERE id = ANY($2::int[])`,
    [Date.now(), ids],
  );
}

async function autoAcknowledgeInfoEvents(
  events: Array<DriftEvent & { id: number }>,
  client: ClientLike = pool,
): Promise<void> {
  const autoIds = events.filter((e) => isAutoAcknowledgeable(e)).map((e) => e.id);
  if (autoIds.length === 0) return;
  await client.query(
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
  // M-5: aggregate observed-firing across all non-self-monitoring rooms (no roomId).
  const truth = await collectCapabilitiesTruth();

  // M-6: DB writes for this run (baseline upsert, drift insert, mark-notified,
  // auto-ack) run in ONE transaction so a mid-run failure leaves the baseline
  // and drift-log consistent. Webhook delivery stays OUTSIDE the tx — network
  // calls inside transactions hold locks open for too long.
  const client: any = await (pool as any).connect();
  let committed = false;
  try {
    await client.query("BEGIN");

    const existing = await getActiveBaseline(client);
    if (!existing) {
      if (!seedIfMissing) {
        await client.query("ROLLBACK");
        committed = true; // skip the finally ROLLBACK
        throw new Error("no active baseline and seedIfMissing=false");
      }
      const newId = await insertBaseline(truth, "auto:first-boot", client);
      await client.query("COMMIT");
      committed = true;
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

    // M-4: read previous observed set from the baseline itself, so silent-regression
    // detection is meaningful across runs.
    const prevObserved = existing.observedFiring;
    const events = detectDrift(existing, truth, prevObserved);
    const driftIds = await insertDriftEvents(events, client);
    const eventsWithIds = events.map((ev, i) => ({ ...ev, id: driftIds[i] }));

    // Auto-acknowledge info severities (env flag changes) per design doc #5
    await autoAcknowledgeInfoEvents(eventsWithIds, client);

    // Baseline update policy (design doc #5):
    //   - If ONLY info events (all env flag changes) → auto-update baseline
    //   - If ANY critical/warn → do NOT update, keep alerting until manual accept
    const hasBlocking = events.some((e) => !isAutoAcknowledgeable(e));
    let newBaselineId = existing.id;
    if (events.length > 0 && !hasBlocking) {
      newBaselineId = await insertBaseline(truth, "auto:info-only-drift", client);
      logger.info(
        { component: "self-monitoring", event: "baseline_auto_updated", baselineId: newBaselineId },
        "[self-monitoring] baseline auto-updated (info-only drift)",
      );
    }

    await client.query("COMMIT");
    committed = true;

    // Alert OUTSIDE the transaction (webhook I/O must not hold DB locks).
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

    return {
      ok: !hasBlocking,
      baseline_seeded: false,
      drift_count: events.length,
      blocking_drift_count: events.filter((e) => !isAutoAcknowledgeable(e)).length,
      baseline_id: newBaselineId,
      drift_ids: driftIds,
      truth_generated_at: truth.generated_at,
    };
  } finally {
    if (!committed) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    }
    if (typeof client.release === "function") client.release();
  }
}

/**
 * Manual baseline acceptance (POST /api/admin/self-monitoring/baseline/accept).
 * Takes a fresh truth snapshot and installs it, acknowledges all outstanding
 * drift events.
 */
export async function acceptCurrentTruthAsBaseline(acceptedBy: string): Promise<{ baseline_id: number; acked_drift_ids: number[] }> {
  const truth = await collectCapabilitiesTruth();
  // Atomic: new baseline + ack-all outstanding drift in one transaction.
  const client: any = await (pool as any).connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const baselineId = await insertBaseline(truth, acceptedBy, client);
    const r = await client.query(
      `UPDATE kioku_capabilities_drift_log
          SET acknowledged = true, acknowledged_at = $1, acknowledged_by = $2
        WHERE acknowledged = false
        RETURNING id`,
      [Date.now(), acceptedBy],
    );
    await client.query("COMMIT");
    committed = true;
    return {
      baseline_id: baselineId,
      acked_drift_ids: r.rows.map((x: any) => x.id),
    };
  } finally {
    if (!committed) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    }
    if (typeof client.release === "function") client.release();
  }
}
