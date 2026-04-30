-- 0012 PR-A.6: room_messages.attachments JSONB + search_text for multimodal Луки
-- Adds two columns and supporting indexes. Idempotent.

ALTER TABLE room_messages
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE room_messages
  ADD COLUMN IF NOT EXISTS search_text TEXT;

CREATE INDEX IF NOT EXISTS idx_room_messages_attachments_nonempty
  ON room_messages USING gin (attachments)
  WHERE jsonb_array_length(attachments) > 0;

CREATE INDEX IF NOT EXISTS idx_room_messages_search_text
  ON room_messages USING gin (to_tsvector('english', coalesce(search_text, '')));
