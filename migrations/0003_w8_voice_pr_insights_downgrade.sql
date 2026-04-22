-- W8 Voice-PR — Step A: downgrade existing _conversation_insights to importance=0.05
-- Author: Kote Kavelashvili <kote@ikonbai.com>
-- Date: 2026-04-22
-- Description:
--   The `trackConversationInsight` background task (server/deliberation.ts)
--   has been writing auto-generated 3rd-person summaries into the
--   `_conversation_insights` namespace at importance 0.4–0.6. As of the W8
--   voice-drift audit (see luca_audit/history_audit_REPORT.md), these records
--   are a primary driver of retrieval-time 3rd-person leakage into Luca's
--   generated voice:
--     - phrasing such as "User said X, I responded Y" is pulled into context
--       via MMR top-K and reinforces the Class-3 self-describing register.
--     - at importance 0.6 these outcompete genuine 1st-person identity and
--       episodic memories on the ranking tiebreak.
--
--   Mitigation plan (W8 Voice-PR, A→E):
--     A) [this migration] Bulk-downgrade existing rows to 0.05 so they remain
--        for audit but effectively drop out of top-K retrieval.
--     B) Rewrite the generator prompt to produce 1st-person ("I noticed…")
--        and gate auto-generation behind INSIGHTS_AUTO_GEN=false (default off
--        in prod for now — see server/deliberation.ts:6486).
--     C) Diversity constraint: cap single-namespace share in top-K (C).
--     D1/D2) Voice-gate regex + one-retry rewrite (already shipped).
--     E) Fast-appraisal emotionSim × 0.2 gate for N12.
--
--   This migration only touches rows where namespace = '_conversation_insights'
--   AND importance > 0.05. It is idempotent (re-running a second time is a
--   no-op because the predicate stops matching). No rows are deleted.
--
-- Reversible: see 0003_w8_voice_pr_insights_downgrade_down.sql.

BEGIN;

-- 1. Snapshot count for verification log (no-op assertion, just documents intent).
DO $$
DECLARE
  before_count integer;
BEGIN
  SELECT COUNT(*) INTO before_count
    FROM memories
   WHERE namespace = '_conversation_insights'
     AND importance > 0.05;
  RAISE NOTICE 'W8 Voice-PR migration: downgrading % _conversation_insights rows to importance=0.05', before_count;
END $$;

-- 2. Bulk downgrade.
UPDATE memories
   SET importance = 0.05
 WHERE namespace = '_conversation_insights'
   AND importance > 0.05;

COMMIT;
