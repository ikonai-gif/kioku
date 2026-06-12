-- 0026_rls_strict.sql -- [LUCA-091 / BRO2] RLS PR3: backdoor removal.
--
-- !!! NOT WIRED INTO BOOTSTRAP. DO NOT APPLY TO PROD WITHOUT A DEDICATED
-- !!! BOSS GO. Prerequisite: the FULL call-site inventory (105 touchpoints
-- !!! across storage/deliberation/routes as of 2026-06-12, vs 6 in the
-- !!! original spec) must be wrapped in withRLS/withService. Applying this
-- !!! early silently empties every unwrapped read.
--
-- Replaces the COALESCE empty-GUC backdoor with the service marker:
-- a session is either user-scoped (app.user_id), service-scoped
-- (app.kioku_service='true', transaction-local), or it sees nothing
-- (luca_skills globals with user_id IS NULL stay public by design).

DROP POLICY IF EXISTS memories_user_isolation ON memories;
CREATE POLICY memories_user_isolation ON memories
  USING (
    current_setting('app.kioku_service', true) = 'true'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

DROP POLICY IF EXISTS rooms_user_isolation ON rooms;
CREATE POLICY rooms_user_isolation ON rooms
  USING (
    current_setting('app.kioku_service', true) = 'true'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

DROP POLICY IF EXISTS room_messages_user_isolation ON room_messages;
CREATE POLICY room_messages_user_isolation ON room_messages
  USING (
    current_setting('app.kioku_service', true) = 'true'
    OR room_id IN (
      SELECT id FROM rooms
      WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::int
    )
  );

DROP POLICY IF EXISTS agent_turns_user_isolation ON agent_turns;
CREATE POLICY agent_turns_user_isolation ON agent_turns
  USING (
    current_setting('app.kioku_service', true) = 'true'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

DROP POLICY IF EXISTS agents_user_isolation ON agents;
CREATE POLICY agents_user_isolation ON agents
  USING (
    current_setting('app.kioku_service', true) = 'true'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

DROP POLICY IF EXISTS skills_user_isolation ON luca_skills;
CREATE POLICY skills_user_isolation ON luca_skills
  USING (
    current_setting('app.kioku_service', true) = 'true'
    OR user_id IS NULL
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );
