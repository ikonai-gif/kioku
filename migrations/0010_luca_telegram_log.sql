-- ────────────────────────────────────────────────────────────────────────────
-- 0010_luca_telegram_log.sql — LEO PR-A: Luca Event-Driven Outreach foundation
--
-- Description: Forensic audit log for every `send_telegram_message` tool call.
--              One row per attempt — success OR failure, in-line OR deferred
--              by quiet-hours. The Telegram tool is fail-silent (never throws),
--              and this table is how we observe what it actually did.
--
-- Why a separate table (not piggyback on tool_runs):
--   tool_runs is keyed by (turn_id, ctx_key, code_sha) for SF3 dedup of a
--   single agent turn's tool execution. A Telegram send may originate from
--   the cron worker (PR-B) outside any agent turn; it may also be deferred
--   by quiet-hours and replayed later by a separate process. Its lifecycle
--   doesn't fit the SF3 pending+terminal pair model. Cheaper to keep a
--   first-class log scoped to (user_id, sent_at) for back-pressure metrics
--   and "did Luca page Kote at 03:00?" queries.
--
-- Columns:
--   - id: UUID for URL-safe forensic linking from the Luca Board UI.
--   - user_id: BOSS whose chat_id received (or would have received) the
--     message. Indexed (user_id, sent_at DESC) so "show me my last N
--     telegrams" is one B-tree lookup.
--   - sent_at: when the attempt was made. NOT necessarily when delivered —
--     deferred sends will record sent_at = decision time, with
--     `error='quiet_hours_deferred'` and `reason` carrying the future
--     defer_until ISO timestamp. PR-B will close the loop with the actual
--     delivery row.
--   - message: the text that was (or would have been) sent. 200-char hard
--     truncate enforced in the tool layer; not constrained at SQL level
--     so that future longer messages don't require a migration.
--   - urgency: tier the classifier (or caller) chose. CHECK constraint
--     keeps the column tightly typed without a Postgres ENUM (cheaper to
--     evolve — adding a value is a code change, not a DDL change).
--   - delivered: TRUE only on confirmed Telegram API 2xx response.
--     FALSE for everything else (network error, missing config, rate-
--     limited, deferred). The partial index on `delivered=false` is the
--     dashboard query for "stuck" attempts.
--   - error: nullable. When `delivered=false`, contains one of:
--       'telegram_not_configured' — env vars missing
--       'rate_limited'            — 5/hour cap hit (in-process limiter)
--       'quiet_hours_deferred'    — blocked by quiet-hours window
--       'fetch_<n>'               — Telegram API non-2xx with status code
--       'fetch_threw:<msg>'       — fetch() rejected (DNS, timeout, abort)
--   - reason: free-form context from the caller (urgency classifier reason
--     like `'vip_sender:kotkave'`, plus any side-channel metadata such as
--     `'defer_until=...'` for deferred rows). Helps post-mortem without
--     joining other tables.
--
-- Retention: ~5 messages/hour cap × 24h = 120 rows/day max per user. No GC
-- needed for years. If cron worker (PR-B) starts firing, still trivial.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS luca_telegram_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message     TEXT NOT NULL,
  urgency     VARCHAR(8) NOT NULL CHECK (urgency IN ('high','normal','low')),
  delivered   BOOLEAN NOT NULL DEFAULT false,
  error       TEXT,
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_luca_telegram_log_user_sent
  ON luca_telegram_log (user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_luca_telegram_log_undelivered
  ON luca_telegram_log (sent_at DESC) WHERE delivered = false;
