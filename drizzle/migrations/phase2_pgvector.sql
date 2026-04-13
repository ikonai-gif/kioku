-- Phase 2: pgvector migration
-- Extension already created

-- Add native vector column
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_vec vector(1536);

-- Migrate existing JSON embeddings to vector column
-- This handles the case where embeddings are stored as JSON text arrays
UPDATE memories
SET embedding_vec = embedding::vector
WHERE embedding IS NOT NULL AND embedding_vec IS NULL;

-- Create HNSW index for fast approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
ON memories USING hnsw (embedding_vec vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, type);
CREATE INDEX IF NOT EXISTS idx_memories_user_namespace ON memories(user_id, namespace);
CREATE INDEX IF NOT EXISTS idx_memories_user_created ON memories(user_id, created_at DESC);
