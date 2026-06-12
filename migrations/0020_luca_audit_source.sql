-- 0020_luca_audit_source.sql — [BRO2-A15 / LUCA-076 §4]
--
-- Tags audit rows produced by scheduled (cron) runs. Spec named the table
-- tool_audit_log; the real table is luca_audit_log (anchor substitution per
-- LUCA-072 precedent: «замени имя, логика та же»).
--   source: 'user' (default) | 'cron'
--   job_id: e.g. 'CRON-1', NULL for interactive calls
-- NOT NULL DEFAULT / NULLABLE → existing rows and inserts unaffected.
-- Idempotent, no backfill, no constraint or index changes.

ALTER TABLE luca_audit_log ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE luca_audit_log ADD COLUMN IF NOT EXISTS job_id TEXT;
