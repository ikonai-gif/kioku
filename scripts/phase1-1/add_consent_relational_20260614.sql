-- Phase 1.1 — consent_relational split [BRO4 ratify / BRO2 build]
-- Forward, idempotent. Run by BOSS on prod (psql "$DATABASE_URL" -f thisfile).
-- NOTE: the column is also auto-created on deploy by ensureSchema() in
-- server/storage.ts; this file is the one-time BACKFILL (data write) + the
-- explicit owner opt-in. No hard deletes.

BEGIN;

-- 1) Column (idempotent; harmless if ensureSchema already created it).
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_relational BOOLEAN DEFAULT FALSE;

-- 2) Backfill (BRO4 spec): existing sensitive-consenters keep relational access,
--    so nobody who already consented is silently degraded. Idempotent.
UPDATE users
   SET consent_relational = consent_sensitive
 WHERE consent_relational IS DISTINCT FROM consent_sensitive
   AND consent_sensitive = TRUE;

-- 3) OWNER opt-in (OPTIONAL — uncomment to restore BOSS relational context
--    WITHOUT enabling health/sensitive consent). user 10 currently has
--    consent_sensitive=FALSE, so step 2 leaves consent_relational=FALSE for him.
-- UPDATE users SET consent_relational = TRUE, consent_updated_at = (extract(epoch from now())*1000)::bigint WHERE id = 10;

COMMIT;

-- Verify (read-only):
--   SELECT id, consent_sensitive, consent_relational FROM users WHERE id = 10;
--
-- Reversal note: no destructive change. To fully revert the column (rarely
-- needed): ALTER TABLE users DROP COLUMN IF EXISTS consent_relational;  (BOSS-only)
