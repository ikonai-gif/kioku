-- ────────────────────────────────────────────────────────────────────────────
-- 0011_telegram_inbound_log.sql — PR-A.5: Telegram Inbound Webhook
--
-- Description: Forensic / idempotency log for every Telegram update that
--              arrives on POST /api/telegram/webhook. Pairs with PR-A's
--              outbound-side luca_telegram_log (0010); together they form
--              the full audit trail for the bidirectional channel.
--
-- Why a separate table from luca_telegram_log:
--   luca_telegram_log captures *outbound* attempts (BOSS-bound messages
--   our side decided to send). This table captures *inbound* — what
--   Telegram delivered to our webhook. Keeping them split means inserts
--   on either side never contend; queries for "did Lука reply to
--   message X" can JOIN, but we don't pay for that on every send.
--
-- The PRIMARY job here is IDEMPOTENCY. Telegram retries delivery on
-- 5xx (and on any non-2xx response with default settings) — multiple
-- replicas plus retries means the same `update_id` can hit the webhook
-- 3+ times. UNIQUE(update_id) + ON CONFLICT DO NOTHING in the route
-- handler guarantees exactly-once dispatch even under concurrent
-- arrivals.
--
-- Columns:
--   - id: BIGSERIAL synthetic PK; cheaper to JOIN against than UUID.
--   - update_id: Telegram's monotonically increasing per-bot update id.
--     UNIQUE-indexed (the idempotency key). NOT NULL.
--   - chat_id / from_id: BIGINT to fit Telegram's 64-bit id space (the
--     migration to 64-bit happened years ago; INT4 is unsafe).
--   - message_text: nullable — non-text messages (photo, voice, file)
--     also get logged with NULL text and a fallback outbound reply.
--   - command_name / command_args: filled iff text matched /\\w+(\\s|$)/.
--     Stored separately from message_text so /queue analytics can
--     GROUP BY command_name without re-parsing.
--   - dispatched_to_room_id: nullable. Set after we successfully
--     persisted the BOSS message into a partner-room. NULL = drop
--     (commands, non-text, errors).
--   - dispatched_at: NOT NULL DEFAULT NOW(). Even rejected/duplicate
--     rows record arrival time for back-pressure metrics.
--   - error: nullable. One of:
--       'partner_room_not_found' — BOSS hasn't created a partner room
--       'rate_limit'             — sliding 10/min per chat hit
--       'rejected_chat_id'       — payload from non-allow-listed chat
--       'malformed'              — zod schema rejected payload
--   - raw_update: JSONB copy of the parsed Telegram update. Lets us
--     replay edge cases offline without re-instrumenting the route.
--
-- Retention: ~10 messages/min × allowlist of 1 chat = ~14k rows/day
-- worst-case. No GC needed for years. PR-B's cron worker can prune if
-- the volume ever changes.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS telegram_inbound_log (
  id                    BIGSERIAL    PRIMARY KEY,
  update_id             BIGINT       UNIQUE NOT NULL,
  chat_id               BIGINT       NOT NULL,
  from_id               BIGINT       NOT NULL,
  message_text          TEXT,
  command_name          TEXT,
  command_args          TEXT,
  dispatched_to_room_id INTEGER,
  dispatched_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  error                 TEXT,
  raw_update            JSONB
);

CREATE INDEX IF NOT EXISTS idx_telegram_inbound_chat_time
  ON telegram_inbound_log (chat_id, dispatched_at DESC);
