-- ────────────────────────────────────────────────────────────────────────────
-- 0006_luca_tool_approvals.sql — Luca Day 6: human-in-the-loop approval gate
-- Description: When Luca calls a HIGH_STAKES_WRITE tool (send_email, github
--              writes, Drive writes, schedule_task, produce_season, etc.),
--              the middleware intercepts the call, creates a pending row
--              here, and returns `{status:"pending_approval", approval_id}`
--              to Luca instead of executing. Kote sees the draft in the
--              Luca Board UI (Day 7) with three buttons — Send / No / Edit.
--              On decision, the real handler runs with final_payload and
--              execution_result is persisted. Next turn, Luca sees the
--              decision replayed as a synthetic tool_result.
--
-- Why a separate table (not a flavor of tool_runs):
--   tool_runs is SF3 dedup-oriented (pending + terminal pair rows keyed by
--   turn_id + ctx_key + code_sha). Approvals have a 3-state decision
--   lifecycle (pending → approved|rejected|edited|timeout|error) plus a
--   draft_payload vs final_payload distinction. Mixing would require a new
--   status enum + optional decision columns on tool_runs, muddying its
--   forensic role. We still write a parallel tool_runs terminal row when
--   the approved tool actually executes downstream — so audit reads both.
--
-- Columns:
--   - id: UUID so the Luca Board UI can reference pending rows via
--     URL-safe id without leaking counts. Matches `meetings.id` style.
--   - agent_id / user_id: agent_id = Luca (always 16 in prod; not hardcoded
--     here — FK to agents). user_id = the user whose approval is required
--     (= Kote for solo Luca sessions; could be room owner in meetings).
--   - meeting_id / turn_id: nullable — solo Luca sessions have no meeting.
--     Helps correlate to tool_runs for the same turn.
--   - tool_name: VARCHAR(64) matches tool_runs.tool width.
--   - draft_payload: the tool_input Luca proposed. JSONB.
--   - final_payload: NULL while pending. On 'send' = draft. On 'edit' =
--     Kote's edited payload. On 'reject'/'timeout' = NULL.
--   - status: pending|approved|rejected|edited|timeout|error. Enforced by
--     CHECK constraint for DB-level typo safety.
--   - decision_note: optional Kote comment (e.g. "clarify first").
--   - expires_at: created_at + 24h by default (configurable per-row).
--     expirePending() worker flips past-deadline rows to 'timeout'.
--   - executed_at: when the downstream handler actually ran. NULL if
--     rejected/timed-out/pending/error-before-exec.
--   - execution_result: the real tool_result returned by the downstream
--     handler. Replayed into Luca's next turn.
--   - code_sha: sha256(tool_name + stable-stringify(draft_payload)).
--     Forensic: lets us group retry-identical requests, AND supports the
--     60s dedupe rule in gate.ts (if Luca retry-loops, reuse pending row).
--
-- Indexes:
--   - idx_ta_pending_by_user: UI home query "show me my pending approvals".
--     Partial index → only pending rows, cheap scans even at scale.
--   - idx_ta_expires: expirePending worker scans this every 60s. Partial
--     index on pending only.
--   - idx_ta_agent_created: "what did Luca propose yesterday?" forensics.
--   - idx_ta_turn: correlate approval rows to tool_runs rows for same turn.
--
-- Rollback: 0006_luca_tool_approvals_down.sql. Safe — LUCA_APPROVAL_GATE_
-- ENABLED=false in prod until Day 7 UI lands → table empty on rollback.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tool_approvals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          INTEGER NOT NULL,
  user_id           INTEGER NOT NULL,
  meeting_id        UUID,
  turn_id           UUID,
  tool_name         VARCHAR(64) NOT NULL,
  draft_payload     JSONB NOT NULL,
  final_payload     JSONB,
  status            VARCHAR(32) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','edited','timeout','error')),
  decision_note     TEXT,
  code_sha          VARCHAR(64) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at        TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL,
  executed_at       TIMESTAMPTZ,
  execution_result  JSONB
);

-- Partial indexes keep scans cheap: pending is a tiny slice of all-time rows.
CREATE INDEX IF NOT EXISTS idx_ta_pending_by_user
  ON tool_approvals (user_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ta_expires
  ON tool_approvals (expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ta_agent_created
  ON tool_approvals (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ta_turn
  ON tool_approvals (turn_id, created_at)
  WHERE turn_id IS NOT NULL;

-- Dedupe support: find recent pending rows by same agent+tool+sha quickly.
-- Used by createPendingApproval's 60s dedupe guard.
CREATE INDEX IF NOT EXISTS idx_ta_dedupe
  ON tool_approvals (agent_id, tool_name, code_sha, created_at DESC)
  WHERE status = 'pending';
