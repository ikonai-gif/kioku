-- Down migration for 0027_eis_events.sql: drop the EIS event audit columns.

ALTER TABLE agent_emotional_state DROP COLUMN IF EXISTS last_event_type;
ALTER TABLE agent_emotional_state DROP COLUMN IF EXISTS last_event_at;
