-- Phase 8: Aesthetic Preferences — taste & style tracking
CREATE TABLE IF NOT EXISTS aesthetic_preferences (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  agent_id    INTEGER NOT NULL,
  category    TEXT NOT NULL,
  item        TEXT NOT NULL,
  reaction    TEXT NOT NULL,
  context     TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aesthetic_prefs_user ON aesthetic_preferences(user_id, category);
CREATE INDEX IF NOT EXISTS idx_aesthetic_prefs_agent ON aesthetic_preferences(agent_id);
