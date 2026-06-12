-- Down migration for 0022_rls_phase2.sql — instant rollback.
ALTER TABLE room_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_turns DISABLE ROW LEVEL SECURITY;
ALTER TABLE agents DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS room_messages_user_isolation ON room_messages;
DROP POLICY IF EXISTS agent_turns_user_isolation ON agent_turns;
DROP POLICY IF EXISTS agents_user_isolation ON agents;
