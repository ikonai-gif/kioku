-- ============================================================================
-- Phase 1b · Point 1 — archive low-value _conversation_insights  (REVERSIBLE)
-- Approved: Luca (Point 1 = GO) + retention policy BRO4 [BRO2-324]. Run by BOSS.
-- Effect: MOVES matching rows from `memories` -> `memories_archive`.
--   NO hard delete. Undo with phase1b_p1_restore.sql.
-- Match (same as the preview BOSS reviewed):
--   namespace='_conversation_insights' AND importance<0.1
--   AND older than 30 days AND fact_key IS NULL AND valid_to IS NULL
-- Idempotent: re-run only moves newly-matching rows.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- Archive table = plain column copy (so the generated content_tsv is stored as
-- a regular column and the INSERT below won't error on a generated target).
CREATE TABLE IF NOT EXISTS memories_archive (LIKE memories);
ALTER TABLE memories_archive ADD COLUMN IF NOT EXISTS archived_at    bigint;
ALTER TABLE memories_archive ADD COLUMN IF NOT EXISTS archive_reason text;

WITH moved AS (
  DELETE FROM memories m
  WHERE m.namespace  = '_conversation_insights'
    AND m.importance < 0.1
    AND m.created_at < (extract(epoch from now())*1000)::bigint - (30::bigint*86400*1000)
    AND m.fact_key  IS NULL
    AND m.valid_to  IS NULL
  RETURNING m.*
)
INSERT INTO memories_archive
SELECT moved.*,
       (extract(epoch from now())*1000)::bigint,
       'phase1b_p1_conversation_insights_imp_lt_0.1_age_gt_30d'
FROM moved;

\echo '--- result: total archived under P1 / remaining _conversation_insights ---'
SELECT
  (SELECT count(*) FROM memories_archive
     WHERE archive_reason='phase1b_p1_conversation_insights_imp_lt_0.1_age_gt_30d') AS total_archived_p1,
  (SELECT count(*) FROM memories WHERE namespace='_conversation_insights')          AS remaining_ci;

COMMIT;
