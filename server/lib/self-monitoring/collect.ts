/**
 * KIOKU™ Self-Monitoring — Capability Truth Collection
 *
 * Extracts the "what does Luca actually have access to right now" snapshot
 * used by both:
 *   - GET /api/admin/luca-capabilities (on-demand)
 *   - Daily health-check job (scheduled)
 *   - Baseline seeding on first boot
 *
 * Source of truth logic:
 *   env_flags  → readLucaEnv()
 *   tools      → getPartnerToolsForAgent({ name: "Luca" })
 *   observed   → tool_activity_log in the last 24h for a given room
 *
 * This module is PURE (no HTTP, no Express). Callable from scheduler jobs
 * or HTTP handlers alike. Computer/agents MUST NOT be a runtime dependency.
 */

import { pool } from "../../storage";
import { getPartnerToolsForAgent, getLucaStudioToolNames } from "../../deliberation";
import { readLucaEnv } from "../luca/env";

// ── Types ────────────────────────────────────────────────────────────────────

export type EnvFlags = {
  LUCA_V1A_ENABLED: boolean;
  LUCA_EXPANDED_SCOPE_ENABLED: boolean;
  LUCA_APPROVAL_GATE_ENABLED: boolean;
  LUCA_APPROVAL_GATE_MODE: string | null;
};

export type ObservedTool = {
  tool: string;
  fire_count: number;
  done_count: number;
  error_count: number;
  last_fired_at: number;
};

export type TruthTableEntry = {
  tool: string;
  category: "v1a" | "base";
  in_schema: true;
  observed_firing_24h: boolean;
  observed: ObservedTool | null;
};

export type CapabilitiesTruth = {
  generated_at: string;
  env_flags: EnvFlags;
  scope_summary: {
    schema_total: number;
    studio_base: number;
    v1a: number;
    observed_firing_24h: number;
  };
  truth_table: TruthTableEntry[];
  observed_firing_24h: ObservedTool[];
};

export type CollectOptions = {
  /** Room to inspect for observed tool firing. Default 151 (Partner room). */
  roomId?: number;
  /** Window in milliseconds. Default 24h. */
  windowMs?: number;
};

// ── Core collector ───────────────────────────────────────────────────────────

/**
 * Build the canonical capability truth snapshot from live runtime state.
 *
 * CONTRACT:
 *   - Reads ENV (via readLucaEnv) — no process.env fallbacks here
 *   - Reads schema (via getPartnerToolsForAgent) — reflects what Luca has
 *     advertised to the model right now
 *   - Reads tool_activity_log for the requested room + window
 *
 * The result is a pure data value; never mutates anything.
 */
export async function collectCapabilitiesTruth(
  opts: CollectOptions = {},
): Promise<CapabilitiesTruth> {
  const roomId = opts.roomId ?? 151;
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;

  // 1. Env-effective scope
  const env = readLucaEnv();
  const envFlags: EnvFlags = {
    LUCA_V1A_ENABLED: !!env.LUCA_V1A_ENABLED,
    LUCA_EXPANDED_SCOPE_ENABLED: !!env.LUCA_EXPANDED_SCOPE_ENABLED,
    LUCA_APPROVAL_GATE_ENABLED: !!env.LUCA_APPROVAL_GATE_ENABLED,
    LUCA_APPROVAL_GATE_MODE: env.LUCA_APPROVAL_GATE_MODE ?? null,
  };

  // 2. Schema (what Luca sees right now at the model layer)
  const tools = getPartnerToolsForAgent({ name: "Luca" });
  const studioNames = Array.from(getLucaStudioToolNames());
  const schemaNames = tools.map((t) => t.name);
  const v1aNames = schemaNames.filter((n) => n.startsWith("luca_"));

  // 3. Observed-firing ground truth
  const since = Date.now() - windowMs;
  const firedR = await pool.query(
    `SELECT tool,
            COUNT(*)::int                                              AS fire_count,
            MAX(started_at)                                            AS last_fired_at,
            SUM(CASE WHEN status = 'done'  THEN 1 ELSE 0 END)::int     AS done_count,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::int     AS error_count
       FROM tool_activity_log
      WHERE room_id = $1 AND started_at >= $2
      GROUP BY tool
      ORDER BY last_fired_at DESC`,
    [roomId, since],
  );
  const observed: ObservedTool[] = firedR.rows.map((r: any) => ({
    tool: r.tool,
    fire_count: r.fire_count,
    done_count: r.done_count,
    error_count: r.error_count,
    last_fired_at: Number(r.last_fired_at),
  }));
  const observedSet = new Set(observed.map((o) => o.tool));

  // 4. Truth table
  const truth_table: TruthTableEntry[] = schemaNames.map((name) => ({
    tool: name,
    category: name.startsWith("luca_") ? "v1a" : "base",
    in_schema: true as const,
    observed_firing_24h: observedSet.has(name),
    observed: observed.find((o) => o.tool === name) ?? null,
  }));

  return {
    generated_at: new Date().toISOString(),
    env_flags: envFlags,
    scope_summary: {
      schema_total: schemaNames.length,
      studio_base: studioNames.length,
      v1a: v1aNames.length,
      observed_firing_24h: observed.length,
    },
    truth_table,
    observed_firing_24h: observed,
  };
}

// ── Baseline-shape normalizer ───────────────────────────────────────────────

/**
 * Reduce a CapabilitiesTruth to the subset stored in
 * kioku_capabilities_baseline. Observed-firing values are NOT part of
 * the baseline (they are a per-sample measurement, not a configuration).
 */
export function truthToBaselineShape(t: CapabilitiesTruth): {
  envFlags: EnvFlags;
  tools: Array<{ tool: string; category: "v1a" | "base"; in_schema: true }>;
} {
  return {
    envFlags: t.env_flags,
    tools: t.truth_table.map(({ tool, category, in_schema }) => ({
      tool,
      category,
      in_schema,
    })),
  };
}
