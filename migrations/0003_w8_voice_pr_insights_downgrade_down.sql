-- W8 Voice-PR — Step A: DOWN migration
-- Reverts 0003_w8_voice_pr_insights_downgrade.sql
--
-- NOTE: This down-migration cannot perfectly restore the original importance
-- distribution (which was a mix of 0.4 and 0.6) because the original values
-- were overwritten by the UP migration. Instead, it restores all downgraded
-- rows to the median legacy value (0.6), which matches the default the
-- `trackConversationInsight` function used for the vast majority of records.
--
-- If a byte-accurate rollback is needed, restore from the pre-migration backup
-- produced by cron eb438bc0 (daily KIOKU dump to Drive). See KIOKU-STATE.md.

BEGIN;

UPDATE memories
   SET importance = 0.6
 WHERE namespace = '_conversation_insights'
   AND importance = 0.05;

COMMIT;
