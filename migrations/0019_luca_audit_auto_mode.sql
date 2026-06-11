-- 0019_luca_audit_auto_mode.sql — [BRO2-A11 / LUCA-073 variant A]
--
-- Adds auto_mode marker to luca_audit_log. NOT NULL DEFAULT false: every
-- existing row and every INSERT that omits the column is unaffected.
-- The column marks calls executed autonomously while LUCA_AUTO_MODE_ENABLED=true
-- (READ_ONLY / LOW_STAKES_WRITE only — HIGH_STAKES is never auto, BOSS HARD RULE).
-- Idempotent, no backfill, no constraint or index changes.

ALTER TABLE luca_audit_log ADD COLUMN IF NOT EXISTS auto_mode BOOLEAN NOT NULL DEFAULT false;
