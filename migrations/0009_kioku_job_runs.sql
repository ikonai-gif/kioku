-- ────────────────────────────────────────────────────────────────────────────
-- 0009_kioku_job_runs.sql — persistent record of internal job executions
--
-- Step 3 (PR #68): migrate external Computer crons into KIOKU itself so the
-- product is self-contained (single product, no external agent dependency).
--
-- Why a DB table (not in-memory Set):
--   - Multi-replica safety on Railway: in-memory dedup is per-process only.
--     Two replicas would both fire the same daily job. A unique
--     (job_id, utc_day) constraint makes the dedup cluster-wide.
--   - Postmortem: need to see when jobs ran, how long, and why they failed.
--   - Observability: feeds admin /api/admin/jobs/status endpoint.
--
-- Pairs with pg_try_advisory_lock(hashtext(job_id)) taken at job entry to
-- prevent concurrent execution within the same replica across ticks or if
-- two replicas race at the same minute.
--
-- Retention: daily jobs produce 1 row/day → ~365 rows/year. No GC needed for
-- years. If annual jobs are added, still trivial volume.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kioku_job_runs (
  id           BIGSERIAL PRIMARY KEY,
  job_id       TEXT        NOT NULL,
  utc_day      DATE        NOT NULL,
  fired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  duration_ms  INTEGER,
  status       TEXT        NOT NULL DEFAULT 'running',   -- 'running' | 'ok' | 'error' | 'skipped'
  error        TEXT,
  detail       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT kioku_job_runs_status_ck
    CHECK (status IN ('running','ok','error','skipped'))
);

-- One successful fire per (job, utc_day). Running/skipped attempts share the
-- same day; the INSERT path uses ON CONFLICT DO NOTHING to claim the day.
CREATE UNIQUE INDEX IF NOT EXISTS kioku_job_runs_job_day_uq
  ON kioku_job_runs (job_id, utc_day);

-- Fast list of "recent runs of job X" for admin status endpoint.
CREATE INDEX IF NOT EXISTS kioku_job_runs_job_fired_at_idx
  ON kioku_job_runs (job_id, fired_at DESC);
