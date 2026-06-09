-- Brick 1.2 (LUCA-053): conversation history search performance.
-- Enables trigram matching so ILIKE '%q%' over room_messages is index-backed.
-- Functionality works without this (plain ILIKE); this is a prod speed-up.
-- Applied by BOSS to prod (Neon). Safe/idempotent.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_room_messages_content_trgm
  ON room_messages USING gin (content gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_room_messages_search_text_trgm
  ON room_messages USING gin (search_text gin_trgm_ops);
