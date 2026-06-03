-- =====================================================================
-- KIOKU — create missing tool_runs table (schema drift fix)
-- Author: BRO2 | 2026-06-03 | Ref: [BRO2-326]
-- RUN BY: BOSS ONLY. Additive only: CREATE TABLE/INDEX. No DELETE, no drop.
-- Idempotent (CREATE ... IF NOT EXISTS). Safe to re-run.
--
-- WHY: prod logs show `relation "tool_runs" does not exist` on every Luca
-- tool call (e.g. luca_notionSearch). The table is defined in
-- shared/schema.ts and migrations/0005_luca_v1a_tool_runs.sql but was never
-- applied to prod. Tools still execute; only the forensic audit insert fails.
-- DDL below mirrors 0005 / schema.ts EXACTLY, with the CHECK named
-- `tool_runs_status_valid` so a later `drizzle-kit push` converges on the
-- same constraint (schema.ts D19 parity note).
--
-- NOT the cause of Luca's silence (that is the Anthropic 60s timeout,
-- BRO1 / [BRO2-326]). This only stops the audit-log spam + restores forensics.
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE TABLE IF NOT EXISTS tool_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            INTEGER NOT NULL,
  agent_id           INTEGER,
  meeting_id         UUID,
  turn_id            UUID,
  ctx_key            VARCHAR(128) NOT NULL,
  tool               VARCHAR(64)  NOT NULL,
  code_sha           VARCHAR(64)  NOT NULL,
  status             VARCHAR(32)  NOT NULL,
  input              JSONB        NOT NULL,
  output             JSONB,
  error_detail       TEXT,
  elapsed_ms         INTEGER,
  memory_peak_bytes  BIGINT,
  network_attempted  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT tool_runs_status_valid
    CHECK (status IN ('pending','ok','error','timeout','memory_exceeded','disabled'))
);

CREATE INDEX IF NOT EXISTS idx_tr_turn            ON tool_runs (turn_id);
CREATE INDEX IF NOT EXISTS idx_tr_meeting_created ON tool_runs (meeting_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tr_user_created    ON tool_runs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tr_code_sha        ON tool_runs (code_sha);
CREATE INDEX IF NOT EXISTS idx_tr_tool_status     ON tool_runs (tool, status);

-- verification (review before COMMIT)
\echo '--- table exists now? (expect: tool_runs) ---'
SELECT to_regclass('public.tool_runs') AS tool_runs_regclass;
\echo '--- column count (expect 16) ---'
SELECT count(*) AS n_columns FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tool_runs';
\echo '--- indexes (expect 5 idx_tr_* + pkey) ---'
SELECT indexname FROM pg_indexes WHERE tablename='tool_runs' ORDER BY 1;

COMMIT;

-- ---------------------------------------------------------------------
-- ROLLBACK (after COMMIT), if ever needed:
--   DROP TABLE IF EXISTS tool_runs;   -- drops table + its indexes
-- (Table is append-only audit; empty until tools log to it. Safe to drop
--  only if you also accept losing any forensic rows written since.)
-- ---------------------------------------------------------------------
