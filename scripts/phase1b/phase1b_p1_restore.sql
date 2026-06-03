-- ============================================================================
-- Phase 1b · Point 1 — UNDO. Moves archived rows back into `memories`.
-- Restores original ids (links/refs stay valid). content_tsv is omitted on
-- purpose — it is a generated column and regenerates from content.
-- Run by BOSS only if the archive needs to be reversed.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

WITH back AS (
  DELETE FROM memories_archive a
  WHERE a.archive_reason = 'phase1b_p1_conversation_insights_imp_lt_0.1_age_gt_30d'
  RETURNING a.*
)
INSERT INTO memories (
  id, user_id, agent_id, agent_name, content, type, importance, namespace, embedding,
  created_at, strength, emotional_valence, last_accessed_at, access_count, embedding_vec,
  confidence, decay_rate, last_reinforced_at, reinforcements, expires_at, cause_id,
  context_trigger, emotion_vector, encrypted, iv, auth_tag, provenance, verified,
  last_verified_at, ccp_y, namespace_legacy, valid_from, valid_to, fact_key
)
SELECT
  id, user_id, agent_id, agent_name, content, type, importance, namespace, embedding,
  created_at, strength, emotional_valence, last_accessed_at, access_count, embedding_vec,
  confidence, decay_rate, last_reinforced_at, reinforcements, expires_at, cause_id,
  context_trigger, emotion_vector, encrypted, iv, auth_tag, provenance, verified,
  last_verified_at, ccp_y, namespace_legacy, valid_from, valid_to, fact_key
FROM back;

\echo '--- restored: _conversation_insights now in memories ---'
SELECT count(*) AS ci_now FROM memories WHERE namespace='_conversation_insights';

COMMIT;
