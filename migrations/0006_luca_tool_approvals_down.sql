-- ────────────────────────────────────────────────────────────────────────────
-- 0006_luca_tool_approvals_down.sql — rollback for Luca Day 6 approval gate
-- Drops tool_approvals table and all its indexes. Safe to run:
-- LUCA_APPROVAL_GATE_ENABLED=false in prod until Day 7 UI ships → table is
-- empty at rollback time. If flipped on and pending rows exist, run this
-- AFTER disabling the flag (rows will be lost — prefer letting them time
-- out naturally or deciding them via the endpoint first).
-- ────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_ta_dedupe;
DROP INDEX IF EXISTS idx_ta_turn;
DROP INDEX IF EXISTS idx_ta_agent_created;
DROP INDEX IF EXISTS idx_ta_expires;
DROP INDEX IF EXISTS idx_ta_pending_by_user;

DROP TABLE IF EXISTS tool_approvals;
