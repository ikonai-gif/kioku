-- ────────────────────────────────────────────────────────────────────────────
-- 0014_luca_audit_log.sql — R465 (BRO2): Luca tool-call audit log
--
-- Description: Append-only forensic record of every `luca_*` tool call that
--              Luca attempts. One row per terminal call. Records ok / error
--              outcomes AND rate-limited / gate-blocked attempts (the latter
--              two are exactly the cases tool_activity_log + tool_runs miss).
--
-- Why a separate table (not piggyback on tool_runs or tool_activity_log):
--   - tool_activity_log is UI-streaming oriented (running→done in place).
--   - tool_runs is V1a-specific (run_code/analyze_image/etc.) using SF3
--     pending+terminal pairs — doesn't cover Studio luca_* tools that
--     route through the main switch (luca_memory_schema, luca_recall_self,
--     luca_self_config) nor capture rate_limited / blocked outcomes.
--   - This table is the SINGLE place to answer "what did Luca try in the
--     last 24 hours?" across the entire luca_* surface.
--
-- Privacy: stores `input_hash` (sha256 of stable-JSON(input)), NOT raw
-- input values. Some inputs carry queries / paths / user context that we
-- don't want to accumulate indefinitely. The hash groups repeated calls
-- and lets us cross-reference tool_runs / tool_activity_log when a raw
-- payload is needed for investigation.
--
-- Columns:
--   - id: BIGSERIAL — high write rate, no need for UUID URL-safety here.
--   - user_id: BOSS whose Luca made the call. Indexed (user_id, created_at
--     DESC) for "Luca's recent activity for this user".
--   - agent_id: nullable — some background callers may not know agentId.
--   - tool: name of the luca_* tool. 64-char cap matches tool_runs.tool.
--   - classification: READ_ONLY | LOW_STAKES_WRITE | HIGH_STAKES_WRITE |
--     UNKNOWN. Mirror of TOOL_WRITE_CLASS at the moment of the call. Stored
--     so retrospective queries don't need to re-import the classifier.
--   - status: ok | error | rate_limited | blocked. CHECK constrained.
--   - input_hash: sha256 hex (64 chars). NEVER raw input.
--   - latency_ms: end-to-end milliseconds the dispatcher saw.
--   - error_detail: nullable, truncated 500 chars. For status=error.
--   - created_at: TIMESTAMPTZ default NOW().
--
-- Retention: one row per luca_* call. Dispatcher rate-limits + Brave
-- search 30/min are the upper bound — at most a few thousand rows/day per
-- active Luca. If volume grows, add a TTL reaper modelled after
-- tool-activity-reaper.test.ts (default 30 days).
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS luca_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL,
  agent_id        INTEGER,
  tool            VARCHAR(64) NOT NULL,
  classification  VARCHAR(24) NOT NULL,
  status          VARCHAR(16) NOT NULL,
  input_hash      VARCHAR(64) NOT NULL,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  error_detail    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT luca_audit_log_status_valid
    CHECK (status IN ('ok','error','rate_limited','blocked')),
  CONSTRAINT luca_audit_log_classification_valid
    CHECK (classification IN ('READ_ONLY','LOW_STAKES_WRITE','HIGH_STAKES_WRITE','UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS idx_luca_audit_user_created
  ON luca_audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_luca_audit_tool_created
  ON luca_audit_log (tool, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_luca_audit_input_hash
  ON luca_audit_log (input_hash);
CREATE INDEX IF NOT EXISTS idx_luca_audit_blocked
  ON luca_audit_log (created_at DESC) WHERE status IN ('rate_limited','blocked','error');
