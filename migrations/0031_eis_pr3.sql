-- 0031_eis_pr3.sql -- [LUCA-099 / BRO2] EIS PR3: OCC appraisal context + persona drift score.
-- Safe: ADD COLUMN IF NOT EXISTS, all nullable. Apply with GO BOSS after PR merge.
-- NOTE: EIS events are audited inline on agent_emotional_state (last_event_*),
-- there is no separate eis_events table. appraisal_context rides alongside.

ALTER TABLE agent_emotional_state ADD COLUMN IF NOT EXISTS last_appraisal_context JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS drift_score DOUBLE PRECISION DEFAULT 0;
