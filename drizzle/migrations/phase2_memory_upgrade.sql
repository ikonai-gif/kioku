-- Phase 2: Memory Types Expansion + Confidence Decay
-- New memory types: temporal, causal, contextual
-- Confidence decay system with reinforcement tracking

-- Confidence decay columns
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 1.0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS decay_rate REAL DEFAULT 0.01;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_reinforced_at BIGINT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS reinforcements INTEGER DEFAULT 0;

-- Type-specific columns
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at BIGINT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS cause_id INTEGER;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS context_trigger TEXT;

-- Index for temporal memory expiration lookups
CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at) WHERE expires_at IS NOT NULL;

-- Index for causal memory lookups
CREATE INDEX IF NOT EXISTS idx_memories_cause_id ON memories(cause_id) WHERE cause_id IS NOT NULL;

-- Set last_reinforced_at to created_at for existing memories
UPDATE memories SET last_reinforced_at = created_at WHERE last_reinforced_at IS NULL;
