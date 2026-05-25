-- Phase 12 reconciliation: align Drizzle with prod 3-col unique index.
-- Prod already has this state via server/storage.ts ad-hoc block; fresh installs apply here.
-- All statements are idempotent — safe to run on any environment.

DO $$
BEGIN
  -- Drop old 2-col constraint under either possible name (Drizzle-generated or storage.ts-generated)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_integrations_user_id_provider_key'
  ) THEN
    ALTER TABLE user_integrations
      DROP CONSTRAINT user_integrations_user_id_provider_key;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_integrations_user_id_provider_unique'
  ) THEN
    ALTER TABLE user_integrations
      DROP CONSTRAINT user_integrations_user_id_provider_unique;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_user_provider_email_key
  ON user_integrations (user_id, provider, COALESCE(email, ''));
