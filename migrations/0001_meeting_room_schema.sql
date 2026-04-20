-- Meeting Room Track A — Week 1 Schema Migration
-- Author: Kote Kavelashvili <kote@ikonbai.com>
-- Date: 2026-04-20
-- Description: Adds meeting room tables: meetings, meeting_participants,
--              meeting_participant_profiles, meeting_context, meeting_artifacts.
--              Also adds room_type column to existing rooms table.
-- Safe to run multiple times (all statements are idempotent via IF NOT EXISTS).

-- ── 1. room_type column on existing rooms table ──────────────────────────────
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS room_type VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (room_type IN ('standard', 'meeting'));

-- ── 2. meetings ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meetings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id           INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  creator_user_id   INTEGER NOT NULL REFERENCES users(id),
  state             VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','active','waiting_for_turn','waiting_for_approval','completed','aborted')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  metadata          JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_meetings_room_id ON meetings(room_id);
CREATE INDEX IF NOT EXISTS idx_meetings_creator ON meetings(creator_user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_state ON meetings(state) WHERE state IN ('active','waiting_for_turn','waiting_for_approval');

-- ── 3. meeting_participants ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meeting_participants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id         UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agent_id           INTEGER NOT NULL REFERENCES agents(id),
  owner_user_id      INTEGER NOT NULL REFERENCES users(id),
  participation_mode VARCHAR(20) NOT NULL DEFAULT 'approve'
    CHECK (participation_mode IN ('observe','approve','autonomous')),
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mp_meeting_id ON meeting_participants(meeting_id);
CREATE INDEX IF NOT EXISTS idx_mp_agent_owner ON meeting_participants(agent_id, owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mp_active ON meeting_participants(meeting_id, agent_id) WHERE left_at IS NULL;

-- ── 4. meeting_participant_profiles ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meeting_participant_profiles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id       UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agent_id         INTEGER NOT NULL REFERENCES agents(id),
  allowed_topics   JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocked_topics   JSONB NOT NULL DEFAULT '[]'::jsonb,
  autonomy_level   VARCHAR(20) NOT NULL DEFAULT 'propose'
    CHECK (autonomy_level IN ('observe','propose','commit','execute')),
  memory_scope     JSONB NOT NULL DEFAULT '{}'::jsonb,
  carry_over_memory BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mpp_meeting_agent ON meeting_participant_profiles(meeting_id, agent_id);

-- ── 5. meeting_context (Lamport-like ordering via sequence_number) ─────────────
CREATE TABLE IF NOT EXISTS meeting_context (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id       UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  sequence_number  BIGINT NOT NULL,
  content          TEXT NOT NULL,
  author_agent_id  INTEGER REFERENCES agents(id),
  visibility       VARCHAR(20) NOT NULL DEFAULT 'all'
    CHECK (visibility IN ('all','owner','scoped')),
  scope_agent_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- integer[] for scoped visibility (e.g. '[1,5,9]'). JSONB for GIN index + efficient @> containment query.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mc_sequence ON meeting_context(meeting_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_mc_meeting ON meeting_context(meeting_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_mc_scope_gin ON meeting_context USING GIN (scope_agent_ids);  -- O(1) "is agent X in scope?" lookup
CREATE SEQUENCE IF NOT EXISTS meeting_context_seq_global;  -- fallback global seq; per-meeting sequence handled in app layer

-- ── 6. meeting_artifacts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meeting_artifacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  type                VARCHAR(30) NOT NULL,
  content             JSONB NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  created_by_agent_id INTEGER REFERENCES agents(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ma_meeting ON meeting_artifacts(meeting_id);
CREATE INDEX IF NOT EXISTS idx_ma_type ON meeting_artifacts(meeting_id, type);
