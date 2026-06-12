-- 0022_rls_phase2.sql — [LUCA-087 / BRO2] RLS Phase 2: room_messages (JOIN policy),
-- agent_turns, agents (llm_api_key — most sensitive column in the system).
-- Same COALESCE/NULLIF legacy-safe shape as 0021 (BRO2 fix #5). Backdoor clause
-- stays until PR3 wraps all internal call-sites (circuit breaker, webhooks).

ALTER TABLE room_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS room_messages_user_isolation ON room_messages;
CREATE POLICY room_messages_user_isolation ON room_messages
  USING (
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR room_id IN (
      SELECT id FROM rooms
      WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::int
    )
  );

ALTER TABLE agent_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_turns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_turns_user_isolation ON agent_turns;
CREATE POLICY agent_turns_user_isolation ON agent_turns
  USING (
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agents_user_isolation ON agents;
CREATE POLICY agents_user_isolation ON agents
  USING (
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );
