-- ────────────────────────────────────────────────────────────────────────────
-- 0015_luca_proposals.sql — R467 (BRO2): Luca self-improvement proposals
--
-- Description: Persistent queue of structured improvement suggestions Luca
--              writes for BOSS to review. Each row is ONE proposal:
--              free-form markdown body + categorical tag + status workflow.
--
-- Why a separate table:
--   - Memories (`memories` table) are write-anytime, low-trust, semantic.
--     Proposals are intentional, indexed by status, and require a human
--     decision. Conflating the two would dilute both.
--   - This table is the SINGLE source of truth for "what does Luca want
--     us to change?" — answerable by a single SQL: `SELECT * FROM
--     luca_proposals WHERE status='pending' ORDER BY created_at DESC`.
--
-- Workflow (today, R467):
--   1. Luca calls `luca_propose_improvement` (LOW_STAKES_WRITE).
--      → row inserted with status='pending', created_at=NOW().
--   2. BOSS reviews via `GET /api/luca/proposals?status=pending`.
--   3. BOSS decides via `POST /api/luca/proposals/:id/decide`
--      with body {decision: 'approved'|'rejected', note?}.
--      → status flips, decided_at=NOW(), decision_note set.
--   4. If approved: BOSS hand-tasks BRO2 to implement. There is NO
--      automatic PR creation in R467 — by explicit user policy.
--      When BRO2 lands the change, BOSS (or a future tool) flips
--      status='applied' and fills applied_pr_url + applied_commit_sha.
--
-- The applied_* fields are RESERVED FOR FUTURE USE. Today they stay NULL
-- on every row. They exist now so we don't need a follow-up migration
-- when (and if) the apply-loop is wired in (Phase 5+ of autonomy).
--
-- Columns:
--   - id: BIGSERIAL — moderate write rate; URL form id is fine.
--   - user_id: BOSS whose Luca made the proposal. Composite-indexed with
--     status for fast pending-queue queries.
--   - agent_id: Luca's agent_id. Nullable to match other luca_* tables.
--   - title: short headline (≤200 chars). NOT NULL.
--   - body: full markdown rationale (≤8000 chars enforced at app layer).
--     TEXT here for safety.
--   - category: one of {tool, prompt, memory, process, other}. CHECK.
--   - status: {pending, approved, rejected, applied}. CHECK.
--     Initial INSERT must be 'pending' (enforced at app layer; CHECK
--     here would block valid future transitions).
--   - created_at: TIMESTAMPTZ default NOW().
--   - decided_at: TIMESTAMPTZ NULL until BOSS decides.
--   - decision_note: optional short note from BOSS (≤500 chars at app).
--   - applied_pr_url: TEXT NULL — reserved.
--   - applied_commit_sha: VARCHAR(40) NULL — reserved (full git sha).
--
-- Retention: indefinite. Volume is capped by Luca rate-limits
-- (5/h + 2/min per agent) — at most ~120 rows/day per active Luca.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS luca_proposals (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL,
  agent_id             INTEGER,
  title                VARCHAR(200) NOT NULL,
  body                 TEXT NOT NULL,
  category             VARCHAR(24) NOT NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at           TIMESTAMPTZ,
  decision_note        TEXT,
  -- RESERVED FOR FUTURE USE — today the only path from approved → applied
  -- is BOSS hand-tasking BRO2. These fields stay NULL until the apply-loop
  -- (Phase 5+) is shipped. Adding them now avoids a follow-up migration.
  applied_pr_url       TEXT,
  applied_commit_sha   VARCHAR(40),
  CONSTRAINT luca_proposals_status_valid
    CHECK (status IN ('pending','approved','rejected','applied')),
  CONSTRAINT luca_proposals_category_valid
    CHECK (category IN ('tool','prompt','memory','process','other'))
);

CREATE INDEX IF NOT EXISTS idx_luca_proposals_user_status_created
  ON luca_proposals (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_luca_proposals_status_created
  ON luca_proposals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_luca_proposals_user_created
  ON luca_proposals (user_id, created_at DESC);
