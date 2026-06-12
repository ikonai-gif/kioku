-- 0027_eis_events.sql -- [LUCA-092 / BRO2] EIS PR2: event audit columns.
--
-- Two nullable audit columns on agent_emotional_state recording the last
-- EIS event that moved the PAD vector (handleEISEvent in server/eis-events.ts).
-- Idempotent; mirrored in the storage.ts bootstrap.

ALTER TABLE agent_emotional_state ADD COLUMN IF NOT EXISTS last_event_type TEXT;
ALTER TABLE agent_emotional_state ADD COLUMN IF NOT EXISTS last_event_at BIGINT;
