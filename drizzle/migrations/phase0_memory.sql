-- Phase 0: Memory system upgrade
-- New columns for emotional memory / decay
ALTER TABLE memories ADD COLUMN IF NOT EXISTS strength REAL DEFAULT 1.0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS emotional_valence REAL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at BIGINT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;

-- Synaptic connections table
CREATE TABLE IF NOT EXISTS memory_links (
  id SERIAL PRIMARY KEY,
  source_memory_id INTEGER NOT NULL,
  target_memory_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'related',
  strength REAL NOT NULL DEFAULT 0.5,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_user ON memory_links(user_id);
