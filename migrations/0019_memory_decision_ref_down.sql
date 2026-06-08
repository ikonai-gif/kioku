-- 0019_memory_decision_ref_down.sql
-- Reverse of 0019: drop the additive decision_ref column from memories.
ALTER TABLE memories DROP COLUMN IF EXISTS decision_ref;
