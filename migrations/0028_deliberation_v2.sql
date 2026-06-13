-- 0028_deliberation_v2.sql -- [LUCA-096 / BRO2] Deliberation v2: topology, minority_view, rounds_taken.
-- Safe: ADD COLUMN IF NOT EXISTS, all nullable. Apply with GO BOSS after PR merge.

ALTER TABLE kioku_deliberation_sessions
  ADD COLUMN IF NOT EXISTS topology TEXT,
  ADD COLUMN IF NOT EXISTS minority_view TEXT,
  ADD COLUMN IF NOT EXISTS rounds_taken INT;
