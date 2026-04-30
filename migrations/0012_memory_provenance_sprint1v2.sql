-- Sprint 1 v2 (BRO1 R373) — Memory honesty layer foundation
-- Adds provenance + verified + last_verified_at to memories table.
-- Idempotent (IF NOT EXISTS) so apply-migration endpoint can re-run safely.
--
-- Why these columns:
--   provenance — answers "how do I know this?". Three values: user_told (explicit
--     statement from Boss), tool_observed (telemetry/tool result), luca_inferred
--     (Luca's own reasoning, the lowest-trust tier). Default for any new memory
--     written without explicit provenance is luca_inferred — opt-in to higher trust.
--   verified — boolean gate: is this memory fact-checked or just a guess? Set to
--     true ONLY by the system, never by Luca's own remember tool (enforced
--     application-level: see server/deliberation.ts:5443 remember-tool handler).
--   last_verified_at — epoch ms of last verification event; null = never. Optional
--     per BRO1 R373 follow-up.
--
-- The 5,000 existing memories will all default to provenance='luca_inferred' and
-- verified=false. That's correct — we have no audit trail to back-fill ground truth,
-- and treating legacy as unverified is the safe failure mode for retrieval.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'luca_inferred';

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS last_verified_at bigint;

-- Provenance check constraint (idempotent — drop-then-add not used; rely on app-level enum).
-- We intentionally do NOT add a CHECK constraint here so future provenance values
-- (e.g. 'tool_observed_high_confidence') can ship via app code without schema migration.

-- Composite index for retrieval: filter by user, optionally namespace, optionally provenance.
-- Used by Sprint 2 conflict-resolution queries that need to bias toward higher-trust sources.
CREATE INDEX IF NOT EXISTS memories_user_namespace_provenance_idx
  ON memories (user_id, namespace, provenance);
