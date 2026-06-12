-- Down migration for 0021_rls_phase1.sql — instant rollback (LUCA-086 acceptance).
ALTER TABLE memories DISABLE ROW LEVEL SECURITY;
ALTER TABLE rooms DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memories_user_isolation ON memories;
DROP POLICY IF EXISTS rooms_user_isolation ON rooms;
