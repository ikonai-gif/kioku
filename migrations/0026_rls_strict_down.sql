-- Down migration for 0026_rls_strict.sql: restore the legacy-safe backdoor
-- policies (0021/0022/0024 shapes). Instant rollback.

DROP POLICY IF EXISTS memories_user_isolation ON memories;
CREATE POLICY memories_user_isolation ON memories
  USING (
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

DROP POLICY IF EXISTS rooms_user_isolation ON rooms;
CREATE POLICY rooms_user_isolation ON rooms
  USING (
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

DROP POLICY IF EXISTS room_messages_user_isolation ON room_messages;
CREATE POLICY room_messages_user_isolation ON room_messages
  USING (
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR room_id IN (
      SELECT id FROM rooms
      WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::int
    )
  );

DROP POLICY IF EXISTS agent_turns_user_isolation ON agent_turns;
CREATE POLICY agent_turns_user_isolation ON agent_turns
  USING (
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

DROP POLICY IF EXISTS agents_user_isolation ON agents;
CREATE POLICY agents_user_isolation ON agents
  USING (
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

DROP POLICY IF EXISTS skills_user_isolation ON luca_skills;
CREATE POLICY skills_user_isolation ON luca_skills
  USING (
    user_id IS NULL
    OR COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );
