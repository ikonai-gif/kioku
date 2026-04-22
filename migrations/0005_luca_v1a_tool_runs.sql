-- ────────────────────────────────────────────────────────────────────────────
-- 0005_luca_v1a_tool_runs.sql — Luca V1a Day 2: tool_runs forensic log
-- Description: Append-only audit log for every Luca tool invocation (run_code
--              lands Day 2; analyze_image / search / memory / file wiring
--              on Day 3-5). Rows are never UPDATEd in place; a pending row
--              at start + a terminal row at end gives us latency diffs and
--              a bulletproof reproduction log.
--
-- Columns:
--   - userId / agentId / meetingId / turnId: scope. meetingId+turnId set
--     for meeting-room runs; standalone Luca calls (future) may leave both
--     null. userId is always set — even "system" invocations tie to Kote=10
--     during dev.
--   - ctxKey: SandboxKey the pyodide runner was invoked with. Matches regex
--     /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/ (Day 1 N1 hardening).
--   - tool: "run_code" (Day 2), later "analyze_image" | "search" |
--     "read_memory" | "write_memory" | "read_file" | "upload_file".
--   - codeSha: SF3 — sha256(code + JSON.stringify(inputs ?? {})). V1 run_code
--     has inputs=undefined → JSON.stringify(undefined)="undefined" which
--     hashes stably. V2 file_upload (not in V1a) will pass file metadata
--     so same code + different file → different sha → no retry collision.
--   - status: pending | ok | error | timeout | memory_exceeded | disabled.
--     Matches RunCodeStatus from pyodide-runner.ts PLUS "pending".
--   - input/output: raw jsonb. output is null until terminal row lands.
--   - elapsedMs / memoryPeakBytes: null for pending row.
--   - networkAttempted: Day 1.5 real pyodide will flip this if network
--     egress is attempted (expected false — no network in sandbox).
--
-- Indexes:
--   - idx_tr_turn: forensic: "what tools did this turn run?"
--   - idx_tr_meeting_created: meeting-wide timeline
--   - idx_tr_user_created: Kote's personal activity feed
--   - idx_tr_code_sha: SF3 retry grouping — find prior runs of same code
--   - idx_tr_tool_status: error-rate telemetry "run_code error rate last hour"
--
-- Rollback: see 0005_luca_v1a_tool_runs_down.sql. Drops table + indexes.
-- No data migration needed — tool_runs is additive and V1a master flag
-- stays off until full merge, so in prod the table is empty at rollback.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tool_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            INTEGER NOT NULL,
  agent_id           INTEGER,
  meeting_id         UUID,
  turn_id            UUID,
  ctx_key            VARCHAR(128) NOT NULL,
  tool               VARCHAR(64) NOT NULL,
  code_sha           VARCHAR(64) NOT NULL,
  status             VARCHAR(32) NOT NULL
                     CHECK (status IN ('pending','ok','error','timeout','memory_exceeded','disabled')),
  input              JSONB NOT NULL,
  output             JSONB,
  error_detail       TEXT,
  elapsed_ms         INTEGER,
  memory_peak_bytes  BIGINT,
  network_attempted  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tr_turn            ON tool_runs (turn_id);
CREATE INDEX IF NOT EXISTS idx_tr_meeting_created ON tool_runs (meeting_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tr_user_created    ON tool_runs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tr_code_sha        ON tool_runs (code_sha);
CREATE INDEX IF NOT EXISTS idx_tr_tool_status     ON tool_runs (tool, status);
