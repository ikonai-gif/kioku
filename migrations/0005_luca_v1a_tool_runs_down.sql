-- ────────────────────────────────────────────────────────────────────────────
-- 0005_luca_v1a_tool_runs_down.sql — rollback for Luca V1a Day 2
-- Drops tool_runs table and all its indexes. Safe to run: master flag
-- LUCA_V1A_ENABLED=false in prod until full V1a merged → table is empty.
-- ────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_tr_tool_status;
DROP INDEX IF EXISTS idx_tr_code_sha;
DROP INDEX IF EXISTS idx_tr_user_created;
DROP INDEX IF EXISTS idx_tr_meeting_created;
DROP INDEX IF EXISTS idx_tr_turn;

DROP TABLE IF EXISTS tool_runs;
