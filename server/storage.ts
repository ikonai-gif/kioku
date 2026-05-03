import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, desc, ilike, or, sql, inArray } from "drizzle-orm";
import {
  users, agents, memories, memoryLinks, flows, rooms, roomMessages, logs, magicTokens, usageTracking, knowledgeDomains, aestheticPreferences,
  type User, type InsertUser,
  type Agent, type InsertAgent,
  type Memory, type InsertMemory,
  type MemoryLink,
  type Flow, type InsertFlow,
  type Room, type InsertRoom,
  type RoomMessage, type InsertRoomMessage,
  type AttachmentMeta,
  type Log, type InsertLog,
  type MagicToken, type InsertMagicToken,
  type UsageTracking,
  type KnowledgeDomain, type InsertKnowledgeDomain,
  type AestheticPreference, type InsertAestheticPreference,
} from "@shared/schema";
import { randomBytes, createHash } from "crypto";
import { computeDecayedStrength, computeDecayedConfidence } from "./memory-decay";
import { provenanceWeight } from "./lib/memory-domain";
import { scoreEmotion } from "./emotion-scorer";
import { embedText } from "./embeddings";
import logger from "./logger";

// ── DB connection ─────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/kioku";
const sslConfig = dbUrl.includes('neon.tech')
  ? { ssl: { rejectUnauthorized: true } }  // Neon uses valid public CA certs
  : (process.env.NODE_ENV === 'production'
    ? { ssl: { rejectUnauthorized: true } }
    : (dbUrl.includes('sslmode=require') ? { ssl: { rejectUnauthorized: true } } : {}));
export const pool = new Pool({
  connectionString: dbUrl,
  // Pool size: 20 (increased from 10 per Bro2 I1 — Meeting Room + Luca + scheduler
  // can consume 8-10 connections concurrently, leaving HTTP starved)
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ...sslConfig,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
  // Don't crash — pool will auto-reconnect on next query
});

export const db = drizzle(pool);

// ── DB readiness flag (Item 3) ──────────────────────────────────────────────────
// Set to true by runInitLoop() in index.ts after initDb() + initDemoUser() succeed.
// Read by the readiness gate middleware to gate /api, /mcp, /v1 paths.
let _dbReady = false;

/** Returns true once initDb() has completed successfully at least once. */
export function isDbReady(): boolean { return _dbReady; }

/** Called by runInitLoop() once DB init succeeds. */
export function markDbReady(): void { _dbReady = true; }

/**
 * Q8.4: Test-only hook to control DB readiness in integration tests.
 * Throws if called outside of NODE_ENV=test to prevent accidental prod use.
 */
export function __setDbReadyForTest(v: boolean): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setDbReadyForTest is test-only");
  }
  _dbReady = v;
}

// ── Migration guard ─────────────────────────────────────────────────────────
/**
 * Atomically claims and runs a named migration.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING to claim the version atomically — only the first
 * instance that inserts wins, preventing TOCTOU races when multiple Railway instances
 * start concurrently. The loser sees rowCount=0 and skips the sql.
 *
 * Monitoring: rows with duration_ms=0 older than 1h indicate a crashed mid-migration
 * instance — alert on SELECT * FROM schema_migrations WHERE duration_ms = 0 AND applied_at < NOW() - INTERVAL '1h'.
 *
 * On SQL failure, the claim row is DELETEd to allow retry on next restart.
 */
export async function runMigration(version: string, sql: string): Promise<void> {
  // Atomic claim: INSERT wins the race, ON CONFLICT DO NOTHING ensures single execution
  const claim = await pool.query(
    `INSERT INTO schema_migrations (version, duration_ms)
     VALUES ($1, 0) ON CONFLICT DO NOTHING`,
    [version],
  );
  if (claim.rowCount === 0) return; // already applied or claimed by another instance

  const start = Date.now();
  try {
    await pool.query(sql);
  } catch (err) {
    // Unclaim — allow retry on next restart. Without this, a failed migration
    // would leave an orphan row and be skipped forever.
    await pool.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    throw err;
  }
  const duration = Date.now() - start;

  await pool.query(
    `UPDATE schema_migrations SET duration_ms = $2 WHERE version = $1`,
    [version, duration],
  );
  logger.info({ version, duration_ms: duration }, '[migration] applied');
}

// ── Schema init (idempotent) ──────────────────────────────────────────────────
export async function initDb() {
  // ── Baseline: schema_migrations table (must be first — runMigration depends on it) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      company      TEXT,
      plan         TEXT NOT NULL DEFAULT 'dev',
      billing_cycle TEXT NOT NULL DEFAULT 'monthly',
      api_key      TEXT NOT NULL UNIQUE,
      created_at   BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS magic_tokens (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      expires_at BIGINT NOT NULL,
      used       BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS agents (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT,
      color          TEXT NOT NULL DEFAULT '#D4AF37',
      status         TEXT NOT NULL DEFAULT 'idle',
      memories_count INTEGER NOT NULL DEFAULT 0,
      last_active_at BIGINT,
      enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at     BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      agent_id   INTEGER,
      agent_name TEXT,
      content    TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'semantic',
      importance REAL NOT NULL DEFAULT 0.5,
      namespace  TEXT,
      embedding  TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flows (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      agent_ids   TEXT NOT NULL DEFAULT '[]',
      positions   TEXT NOT NULL DEFAULT '{}',
      agent_roles TEXT NOT NULL DEFAULT '{}',
      created_at  BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'standby',
      agent_ids   TEXT NOT NULL DEFAULT '[]',
      created_at  BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_messages (
      id          SERIAL PRIMARY KEY,
      room_id     INTEGER NOT NULL,
      agent_id    INTEGER,
      agent_name  TEXT NOT NULL,
      agent_color TEXT NOT NULL DEFAULT '#D4AF37',
      content     TEXT NOT NULL,
      is_decision BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logs (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      agent_name  TEXT,
      agent_color TEXT NOT NULL DEFAULT '#D4AF37',
      operation   TEXT NOT NULL,
      detail      TEXT NOT NULL,
      latency_ms  INTEGER,
      created_at  BIGINT NOT NULL
    );
  `);
  // Phase 3: add stripe_customer_id column if not exists (safe migration)
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
  `);
  // Phase B-1: add model column to agents (multi-model deliberation)
  await pool.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS model TEXT;
  `);
  // Phase B-3: add role column to agents (deliberation roles)
  await pool.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS role TEXT;
  `);
  // Phase C-1: per-agent LLM API key support (agent adapter)
  await pool.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_provider TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_api_key TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_model TEXT;
  `);
  // Phase A: request logging table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kioku_request_logs (
      id          SERIAL PRIMARY KEY,
      timestamp   BIGINT NOT NULL,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      api_key_id  TEXT,
      status_code INTEGER,
      latency_ms  INTEGER,
      error_message TEXT,
      ip          TEXT,
      user_agent  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON kioku_request_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_request_logs_api_key ON kioku_request_logs(api_key_id);
  `);
  // Phase B-5: agent tokens for external agent auth
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kioku_agent_tokens (
      id          SERIAL PRIMARY KEY,
      agent_id    INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL DEFAULT 'default',
      scopes      TEXT NOT NULL DEFAULT '["deliberation.respond","memory.read"]',
      rate_limit  INTEGER NOT NULL DEFAULT 60,
      expires_at  BIGINT,
      revoked     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  BIGINT NOT NULL,
      last_used   BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_token ON kioku_agent_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON kioku_agent_tokens(agent_id);
  `);
  // Phase B-4: webhook registration for external agents
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kioku_webhooks (
      id          SERIAL PRIMARY KEY,
      agent_id    INTEGER NOT NULL UNIQUE,
      user_id     INTEGER NOT NULL,
      url         TEXT NOT NULL,
      secret      TEXT NOT NULL,
      events      TEXT NOT NULL DEFAULT '["deliberation"]',
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON kioku_webhooks(agent_id);
  `);
  // Phase 0: Memory system upgrade — decay columns
  await pool.query(`
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS strength REAL DEFAULT 1.0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS emotional_valence REAL;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at BIGINT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
  `);
  // Phase 0: Synaptic connections table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_links (
      id SERIAL PRIMARY KEY,
      source_memory_id INTEGER NOT NULL,
      target_memory_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'related',
      strength REAL NOT NULL DEFAULT 0.5,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_links_user ON memory_links(user_id);
  `);
  // Phase B-2: deliberation sessions persistence
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kioku_deliberation_sessions (
      id          TEXT PRIMARY KEY,
      room_id     INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      topic       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'running',
      model       TEXT NOT NULL,
      models_used TEXT NOT NULL DEFAULT '[]',
      rounds      TEXT NOT NULL DEFAULT '[]',
      consensus   TEXT,
      started_at  BIGINT NOT NULL,
      completed_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_delib_sessions_room ON kioku_deliberation_sessions(room_id);
    CREATE INDEX IF NOT EXISTS idx_delib_sessions_user ON kioku_deliberation_sessions(user_id);
  `);
  // Phase 2: Memory Types Expansion + Confidence Decay
  await pool.query(`
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 1.0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS decay_rate REAL DEFAULT 0.01;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_reinforced_at BIGINT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS reinforcements INTEGER DEFAULT 0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at BIGINT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS cause_id INTEGER;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS context_trigger TEXT;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at) WHERE expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_cause_id ON memories(cause_id) WHERE cause_id IS NOT NULL;
  `);
  // Set last_reinforced_at for existing memories
  await pool.query(`UPDATE memories SET last_reinforced_at = created_at WHERE last_reinforced_at IS NULL`);
  // Phase 3: External agent connection modes — agent type + webhook fields on agents
  await pool.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type TEXT NOT NULL DEFAULT 'internal';
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_url TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
  `);
  // Phase 3: Polling mode — agent_turns table for pending turn queue
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_turns (
      id          SERIAL PRIMARY KEY,
      session_id  TEXT NOT NULL,
      agent_id    INTEGER NOT NULL,
      room_id     INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      phase       TEXT NOT NULL,
      round       INTEGER NOT NULL DEFAULT 1,
      topic       TEXT NOT NULL,
      other_positions TEXT NOT NULL DEFAULT '[]',
      memories    TEXT NOT NULL DEFAULT '[]',
      status      TEXT NOT NULL DEFAULT 'pending',
      response    TEXT,
      responded_at BIGINT,
      expires_at  BIGINT NOT NULL,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_turns_agent_status ON agent_turns(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_turns_session ON agent_turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_turns_expires ON agent_turns(expires_at);
  `);
  // Phase 4: Circuit breaker — consecutive failure tracking on agents
  await pool.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS error_message TEXT;
  `);
  // Phase 5: Role-based access control
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
  `);
  // Set owner role for user ID 10 (idempotent) — only promotes 'user', won't override 'blocked'/'owner'
  await pool.query(`UPDATE users SET role = 'owner' WHERE id = 10 AND role = 'user'`);

  // Phase 3: Usage metering — per-user per-month tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_tracking (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      period_start  BIGINT NOT NULL,
      period_end    BIGINT NOT NULL,
      deliberations INTEGER NOT NULL DEFAULT 0,
      rounds        INTEGER NOT NULL DEFAULT 0,
      api_calls     INTEGER NOT NULL DEFAULT 0,
      webhook_calls INTEGER NOT NULL DEFAULT 0,
      tokens_used   INTEGER NOT NULL DEFAULT 0,
      updated_at    BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_tracking_user_period ON usage_tracking(user_id, period_start);
    CREATE INDEX IF NOT EXISTS idx_usage_tracking_user ON usage_tracking(user_id);
  `);

  // Phase 6: Stripe webhook idempotency — prevent duplicate event processing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      id SERIAL PRIMARY KEY,
      stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
      type VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'processing',
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_stripe_events_stripe_id ON stripe_events(stripe_event_id);
  `);

  // Phase 4: Emotional architecture — PAD state per agent
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_emotional_state (
      id                   SERIAL PRIMARY KEY,
      agent_id             INTEGER NOT NULL UNIQUE,
      user_id              INTEGER NOT NULL,
      pleasure             REAL NOT NULL DEFAULT 0.0,
      arousal              REAL NOT NULL DEFAULT 0.0,
      dominance            REAL NOT NULL DEFAULT 0.0,
      baseline_pleasure    REAL NOT NULL DEFAULT 0.1,
      baseline_arousal     REAL NOT NULL DEFAULT 0.0,
      baseline_dominance   REAL NOT NULL DEFAULT 0.2,
      emotion_label        TEXT NOT NULL DEFAULT 'neutral',
      poignancy_sum        REAL NOT NULL DEFAULT 0.0,
      half_life_minutes    INTEGER NOT NULL DEFAULT 120,
      last_updated_at      BIGINT NOT NULL,
      created_at           BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emotional_state_agent ON agent_emotional_state(agent_id);
    CREATE INDEX IF NOT EXISTS idx_emotional_state_user ON agent_emotional_state(user_id);
  `);

  // Phase 4: Relationship state per agent-user pair
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_relationships (
      id                 SERIAL PRIMARY KEY,
      agent_id           INTEGER NOT NULL,
      user_id            INTEGER NOT NULL,
      trust_level        REAL NOT NULL DEFAULT 0.0,
      familiarity        REAL NOT NULL DEFAULT 0.0,
      interaction_count  INTEGER NOT NULL DEFAULT 0,
      shared_references  TEXT NOT NULL DEFAULT '[]',
      emotional_history  TEXT NOT NULL DEFAULT '[]',
      stable_opinions    TEXT NOT NULL DEFAULT '{}',
      last_interaction_at BIGINT,
      created_at         BIGINT NOT NULL,
      UNIQUE(agent_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_relationships_agent_user ON agent_relationships(agent_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_user ON agent_relationships(user_id);
  `);

  // Phase 4: Emotion vector column on memories
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS emotion_vector TEXT`);

  // Phase 7: Knowledge Domains — structured knowledge loaded into memory
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_domains (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL,
      description TEXT,
      category    TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'loading',
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL,
      UNIQUE(user_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_domains_user ON knowledge_domains(user_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_domains_user_slug ON knowledge_domains(user_id, slug);
  `);

  // Phase 8: Aesthetic Preferences — taste & style tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS aesthetic_preferences (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      agent_id    INTEGER NOT NULL,
      category    TEXT NOT NULL,
      item        TEXT NOT NULL,
      reaction    TEXT NOT NULL,
      context     TEXT,
      tags        TEXT NOT NULL DEFAULT '[]',
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aesthetic_prefs_user ON aesthetic_preferences(user_id, category);
    CREATE INDEX IF NOT EXISTS idx_aesthetic_prefs_agent ON aesthetic_preferences(agent_id);
  `);

  // Phase 4 Scheduling: scheduled_tasks table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      task_type TEXT NOT NULL,
      cron_expression TEXT,
      scheduled_at BIGINT,
      timezone TEXT DEFAULT 'UTC',
      status TEXT NOT NULL DEFAULT 'active',
      last_run_at BIGINT,
      next_run_at BIGINT,
      run_count INTEGER DEFAULT 0,
      max_runs INTEGER,
      action_type TEXT NOT NULL DEFAULT 'message',
      action_payload TEXT,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON scheduled_tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at) WHERE status = 'active';
  `);

  // Phase 9: Gallery — auto-saved creations (images, writing, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gallery (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      agent_id    INTEGER,
      type        TEXT NOT NULL,
      title       TEXT,
      content_url TEXT,
      content_text TEXT,
      prompt      TEXT,
      metadata    JSONB DEFAULT '{}',
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_user ON gallery(user_id, type);
    CREATE INDEX IF NOT EXISTS idx_gallery_created ON gallery(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS tool_activity_log (
      id           SERIAL PRIMARY KEY,
      step_id      TEXT NOT NULL,
      room_id      INTEGER,
      message_id   INTEGER,
      user_id      INTEGER,
      agent_id     INTEGER,
      tool         TEXT NOT NULL,
      status       TEXT NOT NULL,              -- running | done | error
      description  TEXT,
      preview      TEXT,
      started_at   BIGINT NOT NULL,
      finished_at  BIGINT,
      elapsed_ms   INTEGER,
      created_at   BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_activity_room ON tool_activity_log(room_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_activity_message ON tool_activity_log(message_id) WHERE message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tool_activity_step ON tool_activity_log(step_id);
    -- Phase 2 (R-luca-computer-ui): inline screenshot/media for tool activity rows.
    -- Stored as JSONB array of { storage_key, signed_url, signed_expires_at,
    -- content_type, kind, source_url } so the UI can show thumbnails inline.
    -- BRO1 R431 must-fix: runtime DDL (NOT Drizzle migration) to keep the
    -- ensureToolActivityLog() schema authoritative.
    ALTER TABLE tool_activity_log ADD COLUMN IF NOT EXISTS media_urls JSONB DEFAULT '[]'::jsonb;
  `);

  // Phase 10: Cross-session Decision Provenance Chain
  await pool.query(`
    ALTER TABLE kioku_deliberation_sessions ADD COLUMN IF NOT EXISTS parent_decision_id TEXT;
    ALTER TABLE kioku_deliberation_sessions ADD COLUMN IF NOT EXISTS provenance_chain TEXT DEFAULT '[]';
    ALTER TABLE kioku_deliberation_sessions ADD COLUMN IF NOT EXISTS provenance_chain_id TEXT;
    ALTER TABLE kioku_deliberation_sessions ADD COLUMN IF NOT EXISTS chain_depth INTEGER DEFAULT 0;
    ALTER TABLE kioku_deliberation_sessions ADD COLUMN IF NOT EXISTS chain_metadata JSONB;
    CREATE INDEX IF NOT EXISTS idx_delib_provenance_chain_id ON kioku_deliberation_sessions(provenance_chain_id) WHERE provenance_chain_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_delib_parent_decision ON kioku_deliberation_sessions(parent_decision_id) WHERE parent_decision_id IS NOT NULL;
  `);

  // Phase 11: Privacy/Compliance — consent management & age verification
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_basic BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_sensitive BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_biometric BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_ai_memory BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_updated_at BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS age_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS region TEXT DEFAULT 'us';
  `);

  // Phase 12: Allow multiple accounts per provider (e.g. several Gmail inboxes)
  // Replace the (user_id, provider) unique with (user_id, provider, email).
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_integrations_user_id_provider_key'
      ) THEN
        ALTER TABLE user_integrations DROP CONSTRAINT user_integrations_user_id_provider_key;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_integrations_user_provider_email_key'
      ) THEN
        -- NULL emails are allowed (treated distinct); use coalesce to make NULLs de-dup as empty string
        CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_user_provider_email_key
          ON user_integrations (user_id, provider, COALESCE(email, ''));
      END IF;
    END$$;
  `);

  // ── Meeting Room Track A — Week 1 (2026-04-20) ──────────────────────────────
  // All statements are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
  await pool.query(`
    -- room_type column on existing rooms table
    ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS room_type VARCHAR(20) NOT NULL DEFAULT 'standard'
        CHECK (room_type IN ('standard', 'meeting'));
  `);
  await pool.query(`
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
  `);
  await pool.query(`
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
  `);
  await pool.query(`
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
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_mpp_meeting_agent ON meeting_participant_profiles(meeting_id, agent_id);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meeting_context (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      meeting_id       UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      sequence_number  BIGINT NOT NULL,
      content          TEXT NOT NULL,
      author_agent_id  INTEGER REFERENCES agents(id),
      visibility       VARCHAR(20) NOT NULL DEFAULT 'all'
        CHECK (visibility IN ('all','owner','scoped')),
      scope_agent_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_mc_sequence ON meeting_context(meeting_id, sequence_number);
    CREATE INDEX IF NOT EXISTS idx_mc_scope_gin ON meeting_context USING GIN (scope_agent_ids);
    CREATE SEQUENCE IF NOT EXISTS meeting_context_seq_global;
  `);
  await pool.query(`
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
    CREATE INDEX IF NOT EXISTS idx_ma_type ON meeting_artifacts(meeting_id, type);
  `);

  // ── Week 3 migrations: version-guarded new changes ──────────────────────────────
  // Demo migration: verifies the migration-guard infrastructure works end-to-end.
  // Uses a no-op SQL (SELECT 1) so it is safe to run on any database state.
  await runMigration('v2026_04_21_001_meeting_room_week3', 'SELECT 1;');

  // R-luca-trust-growth (2026-05-02): backfill trust_level for existing
  // relationships that accumulated interactions before the trust-growth bug
  // was fixed. Same +0.005/turn rate as the live increment in
  // incrementInteraction(). LEAST/GREATEST keeps existing higher values
  // intact and clamps at 1.0. Idempotent: running twice produces the same
  // result because we GREATEST-merge with current trust_level.
  await runMigration(
    'v2026_05_02_001_backfill_trust_level',
    `UPDATE agent_relationships
        SET trust_level = LEAST(1.0, GREATEST(trust_level, interaction_count * 0.01))
      WHERE interaction_count > 0
        AND trust_level < LEAST(1.0, interaction_count * 0.01);`
  );
}

// ── Tool activity log (feature #2: history of Luca's steps) ─────────────────────
// Records every partner-tool invocation so users can audit what Luca did.
// Best-effort — failures here must never break the actual tool call.
/**
 * Phase 2 (R-luca-computer-ui): inline media attached to a tool activity row.
 * E.g. agent_browser captures a screenshot, stores it in the private
 * `luca-workspace` Supabase bucket, then attaches the signed URL here so the
 * activity timeline can render an inline thumbnail.
 *
 * `signedExpiresAt` is the epoch-ms when `signedUrl` expires. The API layer
 * re-signs on read when expiry is < 5 min away (BRO1 R431 must-fix #1: keep
 * URLs short-lived for GDPR/CCPA — BOSS California).
 */
export interface ToolActivityMedia {
  storageKey: string;
  signedUrl: string;
  signedExpiresAt: number;
  contentType: string;
  kind: "screenshot" | "file" | "video";
  sourceUrl?: string | null;
}

export interface ToolActivityRecord {
  id: number;
  stepId: string;
  roomId: number | null;
  messageId: number | null;
  userId: number | null;
  agentId: number | null;
  tool: string;
  status: string;
  description: string | null;
  preview: string | null;
  startedAt: number;
  finishedAt: number | null;
  elapsedMs: number | null;
  createdAt: number;
  mediaUrls: ToolActivityMedia[];
}

export async function recordToolActivityStart(params: {
  stepId: string;
  roomId?: number | null;
  userId?: number | null;
  agentId?: number | null;
  tool: string;
  description?: string | null;
  startedAt: number;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO tool_activity_log
         (step_id, room_id, user_id, agent_id, tool, status, description, started_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $7)
       ON CONFLICT DO NOTHING`,
      [
        params.stepId,
        params.roomId ?? null,
        params.userId ?? null,
        params.agentId ?? null,
        params.tool,
        params.description ?? null,
        params.startedAt,
      ]
    );
  } catch (e: any) {
    console.warn("[tool-activity] start insert failed:", e?.message);
  }
}

export async function recordToolActivityEnd(params: {
  stepId: string;
  status: "done" | "error";
  preview?: string | null;
  description?: string | null;
  elapsedMs?: number | null;
  finishedAt: number;
}): Promise<void> {
  try {
    await pool.query(
      `UPDATE tool_activity_log
          SET status = $1,
              preview = COALESCE($2, preview),
              description = COALESCE($3, description),
              elapsed_ms = $4,
              finished_at = $5
        WHERE step_id = $6`,
      [
        params.status,
        params.preview ?? null,
        params.description ?? null,
        params.elapsedMs ?? null,
        params.finishedAt,
        params.stepId,
      ]
    );
  } catch (e: any) {
    console.warn("[tool-activity] end update failed:", e?.message);
  }
}

/**
 * Phase 2 (R-luca-computer-ui): attach media (e.g. screenshot) to a tool
 * activity row by step_id. Best-effort — failures must never break the
 * underlying tool call.
 *
 * Replaces the entire media_urls array (we currently only attach a single
 * screenshot per agent_browser call — future tools may attach multiple).
 */
export async function setToolActivityMedia(
  stepId: string,
  media: ToolActivityMedia[]
): Promise<void> {
  try {
    await pool.query(
      `UPDATE tool_activity_log SET media_urls = $1::jsonb WHERE step_id = $2`,
      [JSON.stringify(media || []), stepId]
    );
  } catch (e: any) {
    console.warn("[tool-activity] media update failed:", e?.message);
  }
}

/**
 * Phase 2 (R-luca-computer-ui): re-sign any media URLs whose signed_expires_at
 * is within `marginMs` of expiry. Best-effort — if re-sign fails we keep the
 * stale URL so the UI still renders something. Persists the refreshed URL
 * back to the DB so subsequent polls pick up the new TTL window.
 */
export async function refreshExpiringMediaForActivity(
  rows: ToolActivityRecord[],
  marginMs: number = 5 * 60 * 1000
): Promise<ToolActivityRecord[]> {
  const now = Date.now();
  // Lazy import to avoid circular deps with workspace-storage at module load.
  let getSignedUrl: ((key: string, expiresSec?: number) => Promise<string>) | null = null;
  try {
    const ws = await import("./workspace-storage");
    if (ws.workspaceEnabled) getSignedUrl = ws.getSignedUrl;
  } catch { /* workspace not configured */ }

  if (!getSignedUrl) return rows;

  for (const row of rows) {
    if (!row.mediaUrls || row.mediaUrls.length === 0) continue;
    let touched = false;
    const refreshed: ToolActivityMedia[] = [];
    for (const m of row.mediaUrls) {
      const willExpireSoon = !m.signedExpiresAt || m.signedExpiresAt - now < marginMs;
      if (!willExpireSoon || !m.storageKey) {
        refreshed.push(m);
        continue;
      }
      try {
        const newUrl = await getSignedUrl(m.storageKey, 3600);
        refreshed.push({
          ...m,
          signedUrl: newUrl,
          signedExpiresAt: now + 3600 * 1000,
        });
        touched = true;
      } catch {
        refreshed.push(m); // keep stale on failure
      }
    }
    if (touched) {
      row.mediaUrls = refreshed;
      // Best-effort persist; don't block the request if it fails.
      setToolActivityMedia(row.stepId, refreshed).catch(() => { /* swallowed */ });
    }
  }
  return rows;
}

/** Internal helper: parse a media_urls JSONB column safely. */
function parseMediaCol(raw: unknown): ToolActivityMedia[] {
  if (!raw) return [];
  let arr: any = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m: any) => m && typeof m === "object" && typeof m.storage_key === "string")
    .map((m: any) => ({
      storageKey: String(m.storage_key),
      signedUrl: String(m.signed_url || ""),
      signedExpiresAt: Number(m.signed_expires_at) || 0,
      contentType: String(m.content_type || "application/octet-stream"),
      kind: (m.kind === "file" || m.kind === "video" ? m.kind : "screenshot") as ToolActivityMedia["kind"],
      sourceUrl: m.source_url ? String(m.source_url) : null,
    }));
}

// Attach the most-recent unattached activity rows (within window) to a
// freshly-persisted Luca message. Called right after we save the message.
export async function attachToolActivityToMessage(params: {
  roomId: number;
  agentId: number;
  messageId: number;
  sinceMs: number;
}): Promise<void> {
  try {
    await pool.query(
      `UPDATE tool_activity_log
          SET message_id = $1
        WHERE room_id = $2
          AND agent_id = $3
          AND message_id IS NULL
          AND created_at >= $4`,
      [params.messageId, params.roomId, params.agentId, params.sinceMs]
    );
  } catch (e: any) {
    console.warn("[tool-activity] attach to message failed:", e?.message);
  }
}

/**
 * Phase 1 — Activity timeline (room-level stream).
 * Returns recent tool_activity_log rows for a room, optionally filtered
 * by `sinceMs` (created_at > sinceMs) so the UI can poll incrementally.
 * Hard-capped at `limit` (default 200) to keep responses small.
 */
export async function getToolActivityForRoom(
  roomId: number,
  opts: { sinceMs?: number; limit?: number } = {}
): Promise<ToolActivityRecord[]> {
  const sinceMs = Number.isFinite(opts.sinceMs) ? Number(opts.sinceMs) : 0;
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  try {
    const res = await pool.query(
      `SELECT id, step_id, room_id, message_id, user_id, agent_id, tool, status,
              description, preview, started_at, finished_at, elapsed_ms, created_at,
              media_urls
         FROM tool_activity_log
        WHERE room_id = $1 AND created_at > $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [roomId, sinceMs, limit]
    );
    // Return chronological order (oldest first) — UI prepends new items.
    return res.rows.reverse().map((r: any) => ({
      id: r.id,
      stepId: r.step_id,
      roomId: r.room_id,
      messageId: r.message_id,
      userId: r.user_id,
      agentId: r.agent_id,
      tool: r.tool,
      status: r.status,
      description: r.description,
      preview: r.preview,
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at != null ? Number(r.finished_at) : null,
      elapsedMs: r.elapsed_ms,
      createdAt: Number(r.created_at),
      mediaUrls: parseMediaCol(r.media_urls),
    }));
  } catch (e: any) {
    console.warn("[tool-activity] room fetch failed:", e?.message);
    return [];
  }
}

export async function getToolActivityForMessage(messageId: number): Promise<ToolActivityRecord[]> {
  try {
    const res = await pool.query(
      `SELECT id, step_id, room_id, message_id, user_id, agent_id, tool, status,
              description, preview, started_at, finished_at, elapsed_ms, created_at,
              media_urls
         FROM tool_activity_log
        WHERE message_id = $1
        ORDER BY started_at ASC, id ASC`,
      [messageId]
    );
    return res.rows.map((r: any) => ({
      id: r.id,
      stepId: r.step_id,
      roomId: r.room_id,
      messageId: r.message_id,
      userId: r.user_id,
      agentId: r.agent_id,
      tool: r.tool,
      status: r.status,
      description: r.description,
      preview: r.preview,
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at != null ? Number(r.finished_at) : null,
      elapsedMs: r.elapsed_ms,
      createdAt: Number(r.created_at),
      mediaUrls: parseMediaCol(r.media_urls),
    }));
  } catch (e: any) {
    console.warn("[tool-activity] fetch failed:", e?.message);
    return [];
  }
}

function generateApiKey(): string {
  return "kk_" + randomBytes(24).toString("hex");
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ── Cosine similarity for embedding search ────────────────────────────────────
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface IStorage {
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByApiKey(apiKey: string): Promise<User | undefined>;
  getUserById(id: number): Promise<User | undefined>;
  createUser(data: { email: string; name: string; company?: string; plan?: string }): Promise<User>;
  updateUserPlan(id: number, plan: string, billingCycle: string): Promise<User | undefined>;
  updateStripeCustomerId(id: number, stripeCustomerId: string): Promise<void>;
  rotateApiKey(id: number): Promise<User | undefined>;
  getUser(id: number): Promise<User | undefined>;

  createMagicToken(email: string): Promise<string>;
  verifyMagicToken(token: string): Promise<string | null>;

  getAgents(userId: number): Promise<Agent[]>;
  getAgent(id: number): Promise<Agent | undefined>;
  createAgent(data: InsertAgent): Promise<Agent>;
  updateAgent(id: number, userId: number, data: Partial<{ name: string; description: string; color: string; model: string; role: string; llmProvider: string | null; llmApiKey: string | null; llmModel: string | null }>): Promise<boolean>;
  updateAgentStatus(id: number, userId: number, status: string): Promise<boolean>;
  toggleAgent(id: number, userId: number, enabled: boolean): Promise<boolean>;
  deleteAgent(id: number, userId: number): Promise<boolean>;
  updateAgentCircuitBreaker(id: number, consecutiveFailures: number, errorMessage: string | null, status?: string): Promise<boolean>;
  resetAgentError(id: number, userId: number): Promise<boolean>;

  getMemories(userId: number, limit?: number): Promise<Memory[]>;
  searchMemories(userId: number, query: string, queryEmbedding?: number[], namespace?: string): Promise<Memory[]>;
  createMemory(data: InsertMemory): Promise<Memory>;
  deleteMemory(id: number, userId: number): Promise<boolean>;
  purgeMemories(userId: number, scope: 'all' | 'agent', agentId?: string): Promise<number>;
  exportMemories(userId: number): Promise<any[]>;
  getMemoriesCount(userId: number): Promise<number>;

  getFlows(userId: number): Promise<Flow[]>;
  getFlow(id: number): Promise<Flow | undefined>;
  createFlow(data: InsertFlow): Promise<Flow>;
  updateFlow(id: number, userId: number, data: Partial<{ name: string; description: string; agentIds: string; positions: string; agentRoles: string }>): Promise<Flow | undefined>;
  deleteFlow(id: number, userId: number): Promise<boolean>;

  getRooms(userId: number): Promise<Room[]>;
  getRoom(id: number, userId?: number): Promise<Room | undefined>;
  createRoom(data: InsertRoom): Promise<Room>;
  updateRoom(id: number, userId: number, data: Partial<{ name: string; description: string; status: string; agentIds: string }>): Promise<Room | undefined>;
  deleteRoom(id: number, userId: number): Promise<boolean>;

  getRoomMessages(roomId: number, userId: number): Promise<RoomMessage[] | null>;
  /** Fetch specific messages by their ids (no user check; for trusted internal callers). */
  getRoomMessagesByIds(ids: number[]): Promise<RoomMessage[]>;
  addRoomMessage(data: InsertRoomMessage, userId?: number): Promise<RoomMessage | null>;
  // PR-A.6 multimodal helpers
  patchAttachment(
    messageId: number,
    attachmentId: string,
    patch: Partial<AttachmentMeta>,
  ): Promise<RoomMessage | null>;
  updateMessageSearchText(messageId: number): Promise<void>;
  markAttachmentExpired(messageId: number, attachmentId: string): Promise<void>;
  getAttachment(messageId: number, attachmentId: string): Promise<AttachmentMeta | null>;
  listExpiredAttachments(now: number): Promise<
    Array<{ messageId: number; attachmentId: string; storageKey: string }>
  >;

  getLogs(userId: number, limit?: number): Promise<Log[]>;
  addLog(data: InsertLog): Promise<Log>;

  getStats(userId: number): Promise<{ totalMemories: number; totalOps: number; avgLatency: number; activeAgents: number }>;

  addGalleryItem(item: { userId: number; agentId?: number | null; type: string; title?: string; contentUrl?: string; contentText?: string; prompt?: string; metadata?: any }): Promise<any>;
  getGalleryItems(userId: number, type?: string, limit?: number, offset?: number): Promise<any[]>;
}

export class Storage implements IStorage {

  getPool(): Pool { return pool; }

  // ── Users ──────────────────────────────────────────────────────────────────
  async getUserByEmail(email: string) {
    return db.select().from(users).where(eq(users.email, email)).limit(1).then(r => r[0]);
  }
  async getUserByApiKey(apiKey: string) {
    const hashed = hashToken(apiKey);
    return db.select().from(users).where(eq(users.apiKey, hashed)).limit(1).then(r => r[0]);
  }
  async getUserById(id: number) {
    return db.select().from(users).where(eq(users.id, id)).limit(1).then(r => r[0]);
  }
  async createUser(data: { email: string; name: string; company?: string; plan?: string }): Promise<User> {
    const existing = await this.getUserByEmail(data.email);
    if (existing) return existing;
    const rawApiKey = generateApiKey();
    const hashedApiKey = hashToken(rawApiKey);
    const [result] = await db.insert(users).values({
      email: data.email,
      name: data.name,
      company: data.company ?? null,
      plan: data.plan ?? "dev",
      billingCycle: "monthly",
      apiKey: hashedApiKey,
      createdAt: Date.now(),
    }).returning();
    // Return with the raw key so it can be shown to the user once
    return { ...result, apiKey: rawApiKey };
  }
  async updateUserPlan(id: number, plan: string, billingCycle: string) {
    return db.update(users).set({ plan, billingCycle }).where(eq(users.id, id)).returning().then(r => r[0]);
  }
  async updateStripeCustomerId(id: number, stripeCustomerId: string) {
    await db.update(users).set({ stripeCustomerId }).where(eq(users.id, id));
  }
  async rotateApiKey(id: number) {
    const rawKey = generateApiKey();
    const hashedKey = hashToken(rawKey);
    const result = await db.update(users).set({ apiKey: hashedKey }).where(eq(users.id, id)).returning().then(r => r[0]);
    if (!result) return undefined;
    // Return with raw key shown once to user
    return { ...result, apiKey: rawKey };
  }
  async getUser(id: number) {
    return this.getUserById(id);
  }

  // ── Magic tokens ───────────────────────────────────────────────────────────
  async createMagicToken(email: string): Promise<string> {
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 15 * 60 * 1000;
    await db.insert(magicTokens).values({ email, token, expiresAt, used: false });
    return token;
  }
  async verifyMagicToken(token: string): Promise<string | null> {
    const [record] = await db.select().from(magicTokens).where(eq(magicTokens.token, token)).limit(1);
    if (!record || record.used || Date.now() > record.expiresAt) return null;
    await db.update(magicTokens).set({ used: true }).where(eq(magicTokens.token, token));
    return record.email;
  }

  // ── Agents ─────────────────────────────────────────────────────────────────
  async getAgents(userId: number) {
    return db.select().from(agents).where(eq(agents.userId, userId));
  }
  async getAgent(id: number) {
    return db.select().from(agents).where(eq(agents.id, id)).limit(1).then(r => r[0]);
  }
  async createAgent(data: InsertAgent): Promise<Agent> {
    const [result] = await db.insert(agents).values({ ...data, createdAt: Date.now() }).returning();
    return result;
  }
  async updateAgent(id: number, userId: number, data: Partial<{ name: string; description: string; color: string; model: string; role: string; llmProvider: string | null; llmApiKey: string | null; llmModel: string | null; agentType: string; webhookUrl: string | null; webhookSecret: string | null }>): Promise<boolean> {
    const result = await db.update(agents).set(data).where(sql`${agents.id} = ${id} AND ${agents.userId} = ${userId}`).returning();
    return result.length > 0;
  }
  async updateAgentStatus(id: number, userId: number, status: string): Promise<boolean> {
    const result = await db.update(agents).set({ status, lastActiveAt: Date.now() }).where(sql`${agents.id} = ${id} AND ${agents.userId} = ${userId}`).returning();
    return result.length > 0;
  }
  async toggleAgent(id: number, userId: number, enabled: boolean): Promise<boolean> {
    const result = await db.update(agents).set({ enabled }).where(sql`${agents.id} = ${id} AND ${agents.userId} = ${userId}`).returning();
    return result.length > 0;
  }
  async updateAgentCircuitBreaker(id: number, consecutiveFailures: number, errorMessage: string | null, status?: string): Promise<boolean> {
    const data: any = { consecutiveFailures, errorMessage };
    if (status) data.status = status;
    const result = await db.update(agents).set(data).where(sql`${agents.id} = ${id}`).returning();
    return result.length > 0;
  }
  async resetAgentError(id: number, userId: number): Promise<boolean> {
    const result = await db.update(agents).set({ consecutiveFailures: 0, errorMessage: null, status: "idle" }).where(sql`${agents.id} = ${id} AND ${agents.userId} = ${userId}`).returning();
    return result.length > 0;
  }
  async deleteAgent(id: number, userId: number): Promise<boolean> {
    const result = await db.delete(agents).where(sql`${agents.id} = ${id} AND ${agents.userId} = ${userId}`).returning();
    return result.length > 0;
  }

  // ── Memories ───────────────────────────────────────────────────────────────
  async getMemories(userId: number, limit = 100, offset = 0) {
    const results = await db.select().from(memories).where(eq(memories.userId, userId))
      .orderBy(desc(memories.importance), desc(memories.createdAt)).limit(limit).offset(offset);
    const now = Date.now();
    return results.map((m: any) => ({
      ...m,
      currentConfidence: computeDecayedConfidence(
        m.confidence ?? 1.0,
        m.decayRate ?? 0.01,
        m.lastReinforcedAt,
        m.createdAt,
        now
      ),
    }));
  }
  async searchMemories(userId: number, query: string, queryEmbedding?: number[], namespace?: string) {
    // Use pgvector for semantic search if embedding provided
    if (queryEmbedding && queryEmbedding.length > 0) {
      const embeddingStr = `[${queryEmbedding.join(',')}]`;

      // Sprint 1 v2 (R373): expires_at filter — the column has existed since Phase 2
      // but no path filtered by it. Bug: temporal memories with past expiresAt were
      // still being returned and scored. Fix: exclude expired here AND in textSearchMemories.
      const nowMs = Date.now();
      let sqlQuery = `
        SELECT *,
          1 - (embedding_vec <=> $1::vector) as similarity,
          COALESCE(strength, 1.0) as effective_strength
        FROM memories
        WHERE user_id = $2
          AND embedding_vec IS NOT NULL
          AND (expires_at IS NULL OR expires_at > $3)
      `;
      const params: any[] = [embeddingStr, userId, nowMs];
      let paramIdx = 4;

      if (namespace) {
        sqlQuery += ` AND namespace = $${paramIdx}`;
        params.push(namespace);
        paramIdx++;
      }

      sqlQuery += `
        ORDER BY embedding_vec <=> $1::vector
        LIMIT $${paramIdx}
      `;
      params.push(40); // Fetch more for post-filtering

      const result = await pool.query(sqlQuery, params);

      // Apply importance + decay + confidence scoring
      const now = Date.now();
      const scored = result.rows
        .filter((r: any) => r.similarity >= 0.5)
        .map((r: any) => {
          const decayedStrength = computeDecayedStrength(
            r.strength ?? 1.0,
            r.type,
            Number(r.created_at),
            r.last_accessed_at ? Number(r.last_accessed_at) : null,
            r.access_count ?? 0,
            now
          );
          const currentConfidence = computeDecayedConfidence(
            r.confidence ?? 1.0,
            r.decay_rate ?? 0.01,
            r.last_reinforced_at ? Number(r.last_reinforced_at) : null,
            Number(r.created_at),
            now
          );
          // Sprint 2 (R372/R384 Q3): additive 10% provenance blend.
          // Old: similarity*0.7 + importance*0.3.
          // New: similarity*0.65 + importance*0.25 + provenanceWeight*0.10.
          // Multiplicative was rejected in R384 — it would obliterate the
          // huge luca_inferred floor (provenanceWeight=0.3). Additive lets
          // a high-similarity luca_inferred memory still win against a
          // low-similarity user_told one when retrieval just needs context.
          const provWeight = provenanceWeight(r.provenance, r.namespace);
          const combinedScore =
            (r.similarity ?? 0) * 0.65 +
            (r.importance ?? 0.5) * 0.25 +
            provWeight * 0.10;
          const finalScore = combinedScore * decayedStrength * currentConfidence;
          return { ...r, similarity: r.similarity, score: finalScore, currentConfidence };
        })
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, 20);

      // Fire-and-forget: update access stats + reinforce confidence
      if (scored.length > 0) {
        const ids = scored.map((s: any) => s.id);
        pool.query(
          `UPDATE memories SET
            last_accessed_at = $1,
            access_count = COALESCE(access_count, 0) + 1,
            last_reinforced_at = $1,
            reinforcements = COALESCE(reinforcements, 0) + 1
          WHERE id = ANY($2)`,
          [now, ids]
        ).catch(() => {});
      }

      if (scored.length > 0) return scored;
    }

    // Text fallback
    return this.textSearchMemories(userId, query, 20, namespace);
  }

  private async textSearchMemories(userId: number, query: string, limit: number, namespace?: string): Promise<any[]> {
    // Sprint 1 v2 (R373): mirror expires_at filter from vector path.
    const nowMs = Date.now();
    let sqlQuery = 'SELECT * FROM memories WHERE user_id = $1 AND (content ILIKE $2 OR agent_name ILIKE $2) AND (expires_at IS NULL OR expires_at > $3)';
    const params: any[] = [userId, `%${query}%`, nowMs];
    let idx = 4;
    if (namespace) {
      sqlQuery += ` AND namespace = $${idx}`;
      params.push(namespace);
      idx++;
    }
    sqlQuery += ` ORDER BY importance DESC, created_at DESC LIMIT $${idx}`;
    params.push(limit);
    const result = await pool.query(sqlQuery, params);
    return result.rows;
  }
  async createMemory(data: InsertMemory): Promise<Memory> {
    const now = Date.now();
    const [mem] = await db.insert(memories).values({
      ...data,
      createdAt: now,
      lastReinforcedAt: now,
      confidence: data.confidence ?? 1.0,
      decayRate: data.decayRate ?? 0.01,
      reinforcements: 0,
    }).returning();

    // Write embedding_vec for pgvector search — use provided embedding or generate one
    let embeddingVec: number[] | null = null;
    if (data.embedding) {
      try {
        const parsed = typeof data.embedding === 'string' ? JSON.parse(data.embedding) : data.embedding;
        if (Array.isArray(parsed) && parsed.length > 0) {
          embeddingVec = parsed;
        }
      } catch { /* will attempt auto-generation below */ }
    }

    // Auto-generate embedding if none was provided
    if (!embeddingVec) {
      try {
        embeddingVec = await embedText(data.content);
      } catch { /* embedding will be null — text search fallback */ }
    }

    // Store embedding_vec
    if (embeddingVec) {
      try {
        const vecStr = `[${embeddingVec.join(',')}]`;
        await pool.query(
          'UPDATE memories SET embedding_vec = $1::vector WHERE id = $2',
          [vecStr, mem.id]
        );
      } catch { /* embedding_vec will be null — text search fallback */ }
    }

    // Fire-and-forget: auto-link to similar memories + emotion scoring
    (async () => {
      try {
        // Auto-link: find 5 most similar memories and create 'related' links
        if (embeddingVec && data.userId) {
          const vecStr = `[${embeddingVec.join(',')}]`;
          const similar = await pool.query(`
            SELECT id, 1 - (embedding_vec <=> $1::vector) as sim
            FROM memories
            WHERE user_id = $2 AND embedding_vec IS NOT NULL AND id != $3
            ORDER BY embedding_vec <=> $1::vector LIMIT 5
          `, [vecStr, data.userId, mem.id]);

          for (const row of similar.rows) {
            if (row.sim > 0.7) {
              await pool.query(`
                INSERT INTO memory_links (user_id, source_memory_id, target_memory_id, link_type, strength, created_at)
                VALUES ($1, $2, $3, 'related', $4, $5)
                ON CONFLICT DO NOTHING
              `, [data.userId, mem.id, row.id, Math.round(row.sim * 1000) / 1000, Date.now()]);
            }
          }
        }
      } catch { /* auto-link failure is non-fatal */ }

      try {
        // Emotion scoring (Phase 4b)
        const emotionVec = await scoreEmotion(data.content);
        if (emotionVec && mem.id) {
          await pool.query('UPDATE memories SET emotion_vector = $1 WHERE id = $2', [JSON.stringify(emotionVec), mem.id]);
        }
      } catch { /* emotion scoring failure is non-fatal */ }
    })();

    if (data.agentId) {
      const agent = await this.getAgent(data.agentId);
      if (agent) {
        await db.update(agents).set({
          memoriesCount: agent.memoriesCount + 1,
          lastActiveAt: Date.now(),
          status: "online",
        }).where(eq(agents.id, data.agentId));
      }
    }
    return mem;
  }
  async getMemory(id: number, userId: number): Promise<Memory | undefined> {
    return db.select().from(memories).where(sql`${memories.id} = ${id} AND ${memories.userId} = ${userId}`).limit(1).then(r => r[0]);
  }

  async reinforceMemory(id: number, userId: number): Promise<void> {
    const now = Date.now();
    await pool.query(
      `UPDATE memories SET
        last_accessed_at = $1,
        access_count = COALESCE(access_count, 0) + 1,
        last_reinforced_at = $1,
        reinforcements = COALESCE(reinforcements, 0) + 1
      WHERE id = $2 AND user_id = $3`,
      [now, id, userId]
    );
  }

  async deleteMemory(id: number, userId: number): Promise<boolean> {
    const result = await db.delete(memories).where(sql`${memories.id} = ${id} AND ${memories.userId} = ${userId}`).returning();
    return result.length > 0;
  }
  async purgeMemories(userId: number, scope: 'all' | 'agent', agentId?: string): Promise<number> {
    if (scope === 'agent' && agentId) {
      const result = await db.delete(memories).where(sql`${memories.userId} = ${userId} AND ${memories.agentId} = ${Number(agentId)}`).returning();
      return result.length;
    }
    const result = await db.delete(memories).where(eq(memories.userId, userId)).returning();
    return result.length;
  }

  async exportMemories(userId: number): Promise<any[]> {
    const all = await db.select({
      id: memories.id,
      content: memories.content,
      type: memories.type,
      importance: memories.importance,
      agentId: memories.agentId,
      agentName: memories.agentName,
      namespace: memories.namespace,
      createdAt: memories.createdAt,
    }).from(memories).where(eq(memories.userId, userId)).orderBy(desc(memories.createdAt));
    return all;
  }

  async getMemoriesCount(userId: number) {
    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM memories WHERE user_id = $1", [userId]
    );
    return parseInt(result.rows[0]?.count ?? "0");
  }

  // ── Memory Links (synaptic connections) ────────────────────────────────────
  async createMemoryLink(userId: number, sourceId: number, targetId: number, linkType: string = "related", strength: number = 0.5) {
    const [source, target] = await Promise.all([
      pool.query('SELECT id FROM memories WHERE id = $1 AND user_id = $2', [sourceId, userId]),
      pool.query('SELECT id FROM memories WHERE id = $1 AND user_id = $2', [targetId, userId]),
    ]);
    if (!source.rows.length || !target.rows.length) return null;
    const result = await pool.query(
      'INSERT INTO memory_links (source_memory_id, target_memory_id, user_id, link_type, strength, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [sourceId, targetId, userId, linkType, strength, Date.now()]
    );
    return result.rows[0];
  }

  async getMemoryLinks(userId: number, memoryId: number) {
    const result = await pool.query(
      `SELECT ml.*, m.content as linked_content, m.type as linked_type
       FROM memory_links ml
       JOIN memories m ON (ml.target_memory_id = m.id OR ml.source_memory_id = m.id) AND m.id != $1
       WHERE ml.user_id = $2 AND (ml.source_memory_id = $1 OR ml.target_memory_id = $1)`,
      [memoryId, userId]
    );
    return result.rows;
  }

  async deleteMemoryLink(userId: number, memoryId: number, linkId: number) {
    await pool.query(
      'DELETE FROM memory_links WHERE id = $1 AND user_id = $2 AND (source_memory_id = $3 OR target_memory_id = $3)',
      [linkId, userId, memoryId]
    );
  }

  async deleteMemoryLinks(userId: number, memoryId: number) {
    await pool.query(
      'DELETE FROM memory_links WHERE user_id = $1 AND (source_memory_id = $2 OR target_memory_id = $2)',
      [userId, memoryId]
    );
  }

  /**
   * Traverse synaptic links to find related memories up to N hops.
   * Uses recursive CTE for BFS through memory_links graph.
   */
  async getLinkedMemories(userId: number, memoryId: number, maxDepth: number = 2, maxResults: number = 20): Promise<any[]> {
    const result = await pool.query(`
      WITH RECURSIVE linked AS (
        -- Seed
        SELECT $1::int as memory_id, 0 as depth, ARRAY[$1::int] as path
        UNION ALL
        -- Traverse links
        SELECT
          CASE WHEN ml.source_memory_id = l.memory_id THEN ml.target_memory_id ELSE ml.source_memory_id END,
          l.depth + 1,
          l.path || CASE WHEN ml.source_memory_id = l.memory_id THEN ml.target_memory_id ELSE ml.source_memory_id END
        FROM linked l
        JOIN memory_links ml ON (ml.source_memory_id = l.memory_id OR ml.target_memory_id = l.memory_id)
          AND ml.user_id = $2
        WHERE l.depth < $3
          AND NOT (CASE WHEN ml.source_memory_id = l.memory_id THEN ml.target_memory_id ELSE ml.source_memory_id END = ANY(l.path))
      )
      SELECT DISTINCT m.*, l.depth, l.path
      FROM linked l
      JOIN memories m ON m.id = l.memory_id AND m.user_id = $2
      WHERE l.memory_id != $1
      ORDER BY l.depth, m.importance DESC
      LIMIT $4
    `, [memoryId, userId, maxDepth, maxResults]);

    return result.rows;
  }

  // ── Flows ──────────────────────────────────────────────────────────────────
  async getFlows(userId: number) {
    return db.select().from(flows).where(eq(flows.userId, userId));
  }
  async getFlow(id: number) {
    return db.select().from(flows).where(eq(flows.id, id)).limit(1).then(r => r[0]);
  }
  async createFlow(data: InsertFlow): Promise<Flow> {
    const [result] = await db.insert(flows).values({ ...data, createdAt: Date.now() }).returning();
    return result;
  }
  async updateFlow(id: number, userId: number, data: Partial<{ name: string; description: string; agentIds: string; positions: string; agentRoles: string }>): Promise<Flow | undefined> {
    return db.update(flows).set(data).where(sql`${flows.id} = ${id} AND ${flows.userId} = ${userId}`).returning().then(r => r[0]);
  }
  async deleteFlow(id: number, userId: number): Promise<boolean> {
    const result = await db.delete(flows).where(sql`${flows.id} = ${id} AND ${flows.userId} = ${userId}`).returning();
    return result.length > 0;
  }

  // ── Rooms ──────────────────────────────────────────────────────────────────
  async getRooms(userId: number) {
    return db.select().from(rooms).where(eq(rooms.userId, userId));
  }
  async getRoom(id: number, userId?: number) {
    if (userId !== undefined) {
      return db.select().from(rooms).where(sql`${rooms.id} = ${id} AND ${rooms.userId} = ${userId}`).limit(1).then(r => r[0]);
    }
    return db.select().from(rooms).where(eq(rooms.id, id)).limit(1).then(r => r[0]);
  }
  async createRoom(data: InsertRoom): Promise<Room> {
    const [result] = await db.insert(rooms).values({ ...data, createdAt: Date.now() }).returning();
    return result;
  }
  async updateRoom(id: number, userId: number, data: Partial<{ name: string; description: string; status: string; agentIds: string }>): Promise<Room | undefined> {
    return db.update(rooms).set(data).where(sql`${rooms.id} = ${id} AND ${rooms.userId} = ${userId}`).returning().then(r => r[0]);
  }
  async deleteRoom(id: number, userId: number): Promise<boolean> {
    const result = await db.delete(rooms).where(sql`${rooms.id} = ${id} AND ${rooms.userId} = ${userId}`).returning();
    return result.length > 0;
  }

  // ── Room Messages ──────────────────────────────────────────────────────────
  async getRoomMessages(roomId: number, userId: number): Promise<RoomMessage[] | null> {
    // Verify room belongs to user
    const room = await this.getRoom(roomId, userId);
    if (!room) return null;
    return db.select().from(roomMessages).where(eq(roomMessages.roomId, roomId))
      .orderBy(roomMessages.createdAt);
  }
  async addRoomMessage(data: InsertRoomMessage, userId?: number): Promise<RoomMessage | null> {
    // If userId provided, verify room belongs to user
    if (userId !== undefined) {
      const room = await this.getRoom(data.roomId, userId);
      if (!room) return null;
    }
    const [result] = await db
      .insert(roomMessages)
      .values({ ...data, createdAt: Date.now() })
      .returning();
    return result;
  }
  /**
   * Fetch a batch of room messages by id. No user-scoped check — used by
   * internal pipelines (e.g. multimodal-history await polling) that already
   * authenticated the caller upstream.
   */
  async getRoomMessagesByIds(ids: number[]): Promise<RoomMessage[]> {
    if (ids.length === 0) return [];
    return db.select().from(roomMessages).where(inArray(roomMessages.id, ids));
  }

  // ── PR-A.6 Multimodal helpers ──────────────────────────────────────────────
  // attachments live as a JSONB array on the room_messages row. Helpers below
  // operate inline using jsonb_set; whole-row UPDATE keeps statements simple
  // and the messages table is small + write rate is low (a handful per turn).

  /** Fetch a single attachment by id, or null if not found. */
  async getAttachment(
    messageId: number,
    attachmentId: string,
  ): Promise<AttachmentMeta | null> {
    const [row] = await db
      .select({ attachments: roomMessages.attachments })
      .from(roomMessages)
      .where(eq(roomMessages.id, messageId));
    if (!row) return null;
    const arr = (row.attachments ?? []) as AttachmentMeta[];
    return arr.find((a) => a.id === attachmentId) ?? null;
  }

  /**
   * Patch a single attachment's fields. Read-modify-write under a single
   * UPDATE — concurrent writers may race; tolerable for single-tenant kioku
   * (one BOSS, low write rate). If multi-tenant ever lands, switch this to a
   * jsonb_set with a SELECT FOR UPDATE.
   */
  async patchAttachment(
    messageId: number,
    attachmentId: string,
    patch: Partial<AttachmentMeta>,
  ): Promise<RoomMessage | null> {
    const [row] = await db
      .select()
      .from(roomMessages)
      .where(eq(roomMessages.id, messageId));
    if (!row) return null;
    const arr = ((row.attachments ?? []) as AttachmentMeta[]).map((a) =>
      a.id === attachmentId ? { ...a, ...patch } : a,
    );
    const [updated] = await db
      .update(roomMessages)
      .set({ attachments: arr })
      .where(eq(roomMessages.id, messageId))
      .returning();
    return updated ?? null;
  }

  /**
   * Re-derive search_text = content + ' ' + each attachment summary/transcription.
   * Called after summarizer fills in summary/transcription/extracted_text so
   * FTS indexes pick up the new content.
   */
  async updateMessageSearchText(messageId: number): Promise<void> {
    const [row] = await db
      .select()
      .from(roomMessages)
      .where(eq(roomMessages.id, messageId));
    if (!row) return;
    const arr = (row.attachments ?? []) as AttachmentMeta[];
    const parts = [row.content];
    for (const a of arr) {
      if (a.summary) parts.push(a.summary);
      if (a.transcription) parts.push(a.transcription);
      if (a.extracted_text) parts.push(a.extracted_text);
      if (a.original_name) parts.push(a.original_name);
    }
    const searchText = parts.filter(Boolean).join(" ").slice(0, 32_000);
    await db
      .update(roomMessages)
      .set({ searchText })
      .where(eq(roomMessages.id, messageId));
  }

  /**
   * Mark an attachment as PII-expired: clear storage_key + signed_url so
   * downstream readers know the binary is gone, but keep summary/
   * transcription so deliberation can still reference what *was* there.
   */
  async markAttachmentExpired(
    messageId: number,
    attachmentId: string,
  ): Promise<void> {
    await this.patchAttachment(messageId, attachmentId, {
      storage_key: null,
      signed_url: null,
      signed_url_expires_at: 0,
    });
  }

  /**
   * Return all attachments whose `expires_at` is in the past and whose
   * `storage_key` is still set (i.e. binary still in Supabase). Used by the
   * daily PII cleanup cron.
   */
  async listExpiredAttachments(
    now: number,
  ): Promise<Array<{ messageId: number; attachmentId: string; storageKey: string }>> {
    const rows = await pool.query<{
      msg_id: number;
      att_id: string;
      key: string;
    }>(
      `SELECT m.id AS msg_id,
              a->>'id' AS att_id,
              a->>'storage_key' AS key
       FROM room_messages m,
            jsonb_array_elements(COALESCE(m.attachments, '[]'::jsonb)) a
       WHERE (a->>'expires_at') IS NOT NULL
         AND (a->>'expires_at')::bigint > 0
         AND (a->>'expires_at')::bigint < $1
         AND a->>'storage_key' IS NOT NULL`,
      [now],
    );
    return rows.rows.map((r) => ({
      messageId: r.msg_id,
      attachmentId: r.att_id,
      storageKey: r.key,
    }));
  }

  // ── Logs ───────────────────────────────────────────────────────────────────
  async getLogs(userId: number, limit = 50) {
    return db.select().from(logs).where(eq(logs.userId, userId))
      .orderBy(desc(logs.createdAt)).limit(limit);
  }
  async addLog(data: InsertLog): Promise<Log> {
    const [result] = await db.insert(logs).values({ ...data, createdAt: Date.now() }).returning();
    return result;
  }

  // ── Request Logs ───────────────────────────────────────────────────────────
  async logRequest(data: {
    method: string; path: string; apiKeyId?: string; statusCode?: number;
    latencyMs?: number; errorMessage?: string; ip?: string; userAgent?: string;
  }) {
    await pool.query(
      `INSERT INTO kioku_request_logs (timestamp, method, path, api_key_id, status_code, latency_ms, error_message, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [Date.now(), data.method, data.path, data.apiKeyId || null, data.statusCode || null,
       data.latencyMs || null, data.errorMessage || null, data.ip || null, data.userAgent || null]
    );
  }

  async getRequestLogs(opts: {
    limit?: number; offset?: number; startDate?: number; endDate?: number;
    apiKeyId?: string; statusCode?: number;
  }) {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (opts.startDate) { conditions.push(`timestamp >= $${idx++}`); params.push(opts.startDate); }
    if (opts.endDate) { conditions.push(`timestamp <= $${idx++}`); params.push(opts.endDate); }
    if (opts.apiKeyId) { conditions.push(`api_key_id = $${idx++}`); params.push(opts.apiKeyId); }
    if (opts.statusCode) { conditions.push(`status_code = $${idx++}`); params.push(opts.statusCode); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    const result = await pool.query(
      `SELECT * FROM kioku_request_logs ${where} ORDER BY timestamp DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM kioku_request_logs ${where}`,
      params
    );
    return { logs: result.rows, total: parseInt(countResult.rows[0]?.total ?? "0"), limit, offset };
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  async getStats(userId: number) {
    const [userAgents, totalMemories, userLogs] = await Promise.all([
      this.getAgents(userId),
      this.getMemoriesCount(userId),
      this.getLogs(userId, 1000),
    ]);
    const totalOps = userLogs.length;
    const latencies = userLogs.filter(l => l.latencyMs).map(l => l.latencyMs!);
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
    const activeAgents = userAgents.filter(a => a.status === "online" && a.enabled).length;
    return { totalMemories, totalOps, avgLatency, activeAgents };
  }

  // ── Deliberation Sessions (raw SQL — no Drizzle schema) ─────────────────────
  async saveDeliberationSession(session: {
    id: string; roomId: number; userId: number; topic: string;
    status: string; model: string; modelsUsed: string[];
    rounds: any[]; consensus: any | null;
    startedAt: number; completedAt: number | null;
    parentDecisionId?: string | null;
    provenanceChain?: string[];
    provenanceChainId?: string | null;
    chainDepth?: number;
    chainMetadata?: object | null;
  }) {
    await pool.query(
      `INSERT INTO kioku_deliberation_sessions (id, room_id, user_id, topic, status, model, models_used, rounds, consensus, started_at, completed_at, parent_decision_id, provenance_chain, provenance_chain_id, chain_depth, chain_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         models_used = EXCLUDED.models_used,
         rounds = EXCLUDED.rounds,
         consensus = EXCLUDED.consensus,
         completed_at = EXCLUDED.completed_at,
         parent_decision_id = EXCLUDED.parent_decision_id,
         provenance_chain = EXCLUDED.provenance_chain,
         provenance_chain_id = EXCLUDED.provenance_chain_id,
         chain_depth = EXCLUDED.chain_depth,
         chain_metadata = EXCLUDED.chain_metadata`,
      [
        session.id, session.roomId, session.userId, session.topic,
        session.status, session.model,
        JSON.stringify(session.modelsUsed),
        JSON.stringify(session.rounds),
        session.consensus ? JSON.stringify(session.consensus) : null,
        session.startedAt, session.completedAt,
        session.parentDecisionId || null,
        JSON.stringify(session.provenanceChain || []),
        session.provenanceChainId || null,
        session.chainDepth ?? 0,
        session.chainMetadata ? JSON.stringify(session.chainMetadata) : null,
      ]
    );
  }

  async getDeliberationSession(sessionId: string) {
    const { rows } = await pool.query(
      `SELECT * FROM kioku_deliberation_sessions WHERE id = $1`, [sessionId]
    );
    return rows[0] ? this.mapDelibRow(rows[0]) : undefined;
  }

  async getDeliberationsByRoom(roomId: number) {
    const { rows } = await pool.query(
      `SELECT * FROM kioku_deliberation_sessions WHERE room_id = $1 ORDER BY started_at DESC`, [roomId]
    );
    return rows.map((r: any) => this.mapDelibRow(r));
  }

  async getLatestConsensus(roomId: number) {
    const { rows } = await pool.query(
      `SELECT consensus FROM kioku_deliberation_sessions
       WHERE room_id = $1 AND status = 'completed' AND consensus IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`, [roomId]
    );
    if (!rows[0]) return null;
    return JSON.parse(rows[0].consensus);
  }

  // ── Agent Tokens (external agent auth) ──────────────────────────────
  async createAgentToken(data: { agentId: number; userId: number; name?: string; scopes?: string[]; expiresInDays?: number }) {
    const rawToken = "kat_" + randomBytes(32).toString("hex");
    const hashedToken = hashToken(rawToken);
    const scopes = JSON.stringify(data.scopes || ["deliberation.respond", "memory.read"]);
    const expiresAt = data.expiresInDays ? Date.now() + data.expiresInDays * 86400000 : null;
    await pool.query(
      `INSERT INTO kioku_agent_tokens (agent_id, user_id, token, name, scopes, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [data.agentId, data.userId, hashedToken, data.name || "default", scopes, expiresAt, Date.now()]
    );
    // Return raw token once — only the hash is stored
    return { token: rawToken, agentId: data.agentId, name: data.name || "default", scopes: data.scopes || ["deliberation.respond", "memory.read"], expiresAt };
  }

  async validateAgentToken(token: string) {
    const hashedToken = hashToken(token);
    const { rows } = await pool.query(
      `SELECT * FROM kioku_agent_tokens WHERE token = $1 AND revoked = FALSE`, [hashedToken]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    // Check expiration
    if (row.expires_at && Date.now() > Number(row.expires_at)) return null;
    // Update last_used
    await pool.query(`UPDATE kioku_agent_tokens SET last_used = $1 WHERE id = $2`, [Date.now(), row.id]);
    return {
      id: row.id,
      agentId: row.agent_id as number,
      userId: row.user_id as number,
      name: row.name as string,
      scopes: JSON.parse(row.scopes || '[]') as string[],
    };
  }

  async getAgentTokens(agentId: number, userId?: number) {
    const query = userId !== undefined
      ? `SELECT id, agent_id, user_id, name, scopes, rate_limit, expires_at, revoked, created_at, last_used
         FROM kioku_agent_tokens WHERE agent_id = $1 AND user_id = $2 ORDER BY created_at DESC`
      : `SELECT id, agent_id, user_id, name, scopes, rate_limit, expires_at, revoked, created_at, last_used
         FROM kioku_agent_tokens WHERE agent_id = $1 ORDER BY created_at DESC`;
    const params = userId !== undefined ? [agentId, userId] : [agentId];
    const { rows } = await pool.query(query, params);
    return rows.map((r: any) => ({
      id: r.id,
      agentId: r.agent_id,
      userId: r.user_id,
      name: r.name,
      scopes: JSON.parse(r.scopes || '[]'),
      rateLimit: r.rate_limit,
      expiresAt: r.expires_at ? Number(r.expires_at) : null,
      revoked: r.revoked,
      createdAt: Number(r.created_at),
      lastUsed: r.last_used ? Number(r.last_used) : null,
    }));
  }

  async revokeAgentToken(tokenId: number, userId?: number): Promise<boolean> {
    if (userId !== undefined) {
      const result = await pool.query(`UPDATE kioku_agent_tokens SET revoked = TRUE WHERE id = $1 AND user_id = $2 RETURNING id`, [tokenId, userId]);
      return result.rows.length > 0;
    }
    await pool.query(`UPDATE kioku_agent_tokens SET revoked = TRUE WHERE id = $1`, [tokenId]);
    return true;
  }

  async revokeAllAgentTokens(agentId: number, userId?: number): Promise<boolean> {
    if (userId !== undefined) {
      const result = await pool.query(`UPDATE kioku_agent_tokens SET revoked = TRUE WHERE agent_id = $1 AND user_id = $2 RETURNING id`, [agentId, userId]);
      return result.rows.length > 0;
    }
    await pool.query(`UPDATE kioku_agent_tokens SET revoked = TRUE WHERE agent_id = $1`, [agentId]);
    return true;
  }

  // ── Webhooks (external agents) ────────────────────────────────────────
  async registerWebhook(data: { agentId: number; userId: number; url: string; secret: string; events?: string[] }) {
    const events = JSON.stringify(data.events || ["deliberation"]);
    await pool.query(
      `INSERT INTO kioku_webhooks (agent_id, user_id, url, secret, events, active, created_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       ON CONFLICT (agent_id) DO UPDATE SET
         url = EXCLUDED.url, secret = EXCLUDED.secret, events = EXCLUDED.events, active = TRUE`,
      [data.agentId, data.userId, data.url, data.secret, events, Date.now()]
    );
  }

  async getWebhook(agentId: number, userId?: number) {
    const query = userId !== undefined
      ? `SELECT * FROM kioku_webhooks WHERE agent_id = $1 AND active = TRUE AND user_id = $2`
      : `SELECT * FROM kioku_webhooks WHERE agent_id = $1 AND active = TRUE`;
    const params = userId !== undefined ? [agentId, userId] : [agentId];
    const { rows } = await pool.query(query, params);
    if (!rows[0]) return undefined;
    return {
      id: rows[0].id,
      agentId: rows[0].agent_id,
      userId: rows[0].user_id,
      url: rows[0].url,
      secret: rows[0].secret,
      events: JSON.parse(rows[0].events || '[]') as string[],
      active: rows[0].active,
      createdAt: Number(rows[0].created_at),
    };
  }

  async getWebhooksByUser(userId: number) {
    const { rows } = await pool.query(
      `SELECT * FROM kioku_webhooks WHERE user_id = $1 ORDER BY created_at DESC`, [userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      agentId: r.agent_id,
      userId: r.user_id,
      url: r.url,
      secret: r.secret,
      events: JSON.parse(r.events || '[]') as string[],
      active: r.active,
      createdAt: Number(r.created_at),
    }));
  }

  async deleteWebhook(agentId: number, userId?: number): Promise<boolean> {
    if (userId !== undefined) {
      const result = await pool.query(`DELETE FROM kioku_webhooks WHERE agent_id = $1 AND user_id = $2 RETURNING id`, [agentId, userId]);
      return result.rows.length > 0;
    }
    await pool.query(`DELETE FROM kioku_webhooks WHERE agent_id = $1`, [agentId]);
    return true;
  }

  // ── GDPR Art. 17: Full account deletion ─────────────────────────────────
  async deleteAccount(userId: number): Promise<void> {
    // Delete in order respecting foreign key dependencies
    // 1. Memory links (references memories)
    await pool.query('DELETE FROM memory_links WHERE user_id = $1', [userId]);
    // 2. Emotional state + relationships (references agents)
    await pool.query('DELETE FROM agent_emotional_state WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM agent_relationships WHERE user_id = $1', [userId]);
    // 3. Memories
    await pool.query('DELETE FROM memories WHERE user_id = $1', [userId]);
    // 4. Room messages (references rooms)
    await pool.query('DELETE FROM room_messages WHERE room_id IN (SELECT id FROM rooms WHERE user_id = $1)', [userId]);
    // 4. Rooms
    await pool.query('DELETE FROM rooms WHERE user_id = $1', [userId]);
    // 5. Agents
    await pool.query('DELETE FROM agents WHERE user_id = $1', [userId]);
    // 6. Flows
    await pool.query('DELETE FROM flows WHERE user_id = $1', [userId]);
    // 7. Logs
    await pool.query('DELETE FROM logs WHERE user_id = $1', [userId]);
    // 8. Deliberation sessions
    await pool.query('DELETE FROM kioku_deliberation_sessions WHERE user_id = $1', [userId]);
    // 9. Agent tokens
    await pool.query('DELETE FROM kioku_agent_tokens WHERE user_id = $1', [userId]);
    // 10. Webhooks
    await pool.query('DELETE FROM kioku_webhooks WHERE user_id = $1', [userId]);
    // 10b. Scheduled tasks
    await pool.query('DELETE FROM scheduled_tasks WHERE user_id = $1', [userId]);
    // 10c. Knowledge domains
    await pool.query('DELETE FROM knowledge_domains WHERE user_id = $1', [userId]);
    // 10c. Aesthetic preferences
    await pool.query('DELETE FROM aesthetic_preferences WHERE user_id = $1', [userId]);
    // 11. Magic tokens (keyed by email, resolve from user)
    const userRow = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    if (userRow.rows[0]?.email) {
      await pool.query('DELETE FROM magic_tokens WHERE email = $1', [userRow.rows[0].email]);
    }
    // 12. User record
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }

  // ── GDPR Art. 20: Full data export ─────────────────────────────────────────
  async exportAllUserData(userId: number): Promise<any> {
    const [user, memoriesData, agentsData, roomsData, messagesData, flowsData, logsData, deliberations, webhooks, tokens] = await Promise.all([
      pool.query('SELECT id, email, name, plan, created_at FROM users WHERE id = $1', [userId]),
      pool.query('SELECT id, content, type, importance, namespace, created_at, strength, emotional_valence FROM memories WHERE user_id = $1', [userId]),
      pool.query('SELECT id, name, description, status, created_at FROM agents WHERE user_id = $1', [userId]),
      pool.query('SELECT id, name, description, created_at FROM rooms WHERE user_id = $1', [userId]),
      pool.query('SELECT rm.id, rm.content, rm.agent_name, rm.created_at, rm.room_id FROM room_messages rm JOIN rooms r ON rm.room_id = r.id WHERE r.user_id = $1', [userId]),
      pool.query('SELECT id, name, description, created_at FROM flows WHERE user_id = $1', [userId]),
      pool.query('SELECT id, operation, detail, created_at FROM logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000', [userId]),
      pool.query('SELECT id, room_id, topic, status, started_at FROM kioku_deliberation_sessions WHERE user_id = $1', [userId]),
      pool.query('SELECT id, url, events, created_at FROM kioku_webhooks WHERE user_id = $1', [userId]),
      pool.query('SELECT id, name, scopes, expires_at, created_at FROM kioku_agent_tokens WHERE user_id = $1', [userId]),
    ]);

    return {
      exportDate: new Date().toISOString(),
      user: user.rows[0] || null,
      memories: memoriesData.rows,
      agents: agentsData.rows,
      rooms: roomsData.rows,
      messages: messagesData.rows,
      flows: flowsData.rows,
      activityLogs: logsData.rows,
      deliberationSessions: deliberations.rows,
      webhooks: webhooks.rows,
      agentTokens: tokens.rows,
    };
  }

  // ── KMEF v1.0: Full data export (KIOKU Memory Exchange Format) ─────────────
  async exportKMEF(userId: number): Promise<any> {
    const [
      userData, memoriesData, agentsData, roomsData, messagesData,
      flowsData, deliberationsData, memoryLinksData, usageData, usageHistoryData,
      webhooksData, tokensData,
    ] = await Promise.all([
      pool.query('SELECT id, email, name, company, plan, billing_cycle, created_at FROM users WHERE id = $1', [userId]),
      pool.query(`SELECT id, content, type, importance, confidence, decay_rate, strength,
        emotional_valence, agent_id, agent_name, namespace, access_count,
        last_accessed_at, last_reinforced_at, reinforcements,
        expires_at, cause_id, context_trigger, created_at
        FROM memories WHERE user_id = $1 ORDER BY created_at DESC`, [userId]),
      pool.query(`SELECT id, name, description, role, model, llm_provider, agent_type,
        status, memories_count, enabled, created_at
        FROM agents WHERE user_id = $1`, [userId]),
      pool.query('SELECT id, name, description, status, agent_ids, created_at FROM rooms WHERE user_id = $1', [userId]),
      pool.query(`SELECT rm.id, rm.content, rm.agent_id, rm.agent_name, rm.is_decision, rm.created_at, rm.room_id
        FROM room_messages rm JOIN rooms r ON rm.room_id = r.id WHERE r.user_id = $1 ORDER BY rm.created_at`, [userId]),
      pool.query('SELECT id, name, description, agent_ids, created_at FROM flows WHERE user_id = $1', [userId]),
      pool.query(`SELECT id, room_id, topic, status, model, models_used, rounds, consensus,
        started_at, completed_at FROM kioku_deliberation_sessions WHERE user_id = $1 ORDER BY started_at DESC`, [userId]),
      pool.query(`SELECT ml.* FROM memory_links ml WHERE ml.user_id = $1`, [userId]),
      pool.query(`SELECT * FROM usage_tracking WHERE user_id = $1 ORDER BY period_start DESC LIMIT 1`, [userId]),
      pool.query(`SELECT * FROM usage_tracking WHERE user_id = $1 ORDER BY period_start DESC LIMIT 12`, [userId]),
      pool.query('SELECT id, url, events, created_at FROM kioku_webhooks WHERE user_id = $1', [userId]),
      pool.query('SELECT id, name, scopes, expires_at, created_at FROM kioku_agent_tokens WHERE user_id = $1', [userId]),
    ]);

    const user = userData.rows[0];
    const currentUsage = usageData.rows[0];

    return {
      kmef_version: "1.0",
      exported_at: new Date().toISOString(),
      platform: "kioku",
      platform_version: "1.0.0",
      account: user ? {
        email: user.email,
        name: user.name,
        company: user.company,
        plan: user.plan,
        billing_cycle: user.billing_cycle,
        created_at: user.created_at,
      } : null,
      agents: agentsData.rows.map((a: any) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        model: a.model,
        llm_provider: a.llm_provider,
        description: a.description,
        agent_type: a.agent_type,
        status: a.status,
        memories_count: a.memories_count,
        enabled: a.enabled,
        created_at: a.created_at,
      })),
      memories: memoriesData.rows.map((m: any) => ({
        id: m.id,
        content: m.content,
        type: m.type,
        importance: m.importance,
        confidence: m.confidence,
        confidence_history: this.buildConfidenceHistory(m),
        decay_parameters: {
          rate: m.decay_rate,
          last_reinforced_at: m.last_reinforced_at,
          reinforcements: m.reinforcements,
        },
        strength: m.strength,
        emotional_valence: m.emotional_valence,
        agent_id: m.agent_id,
        agent_name: m.agent_name,
        namespace: m.namespace,
        access_count: m.access_count,
        last_accessed_at: m.last_accessed_at,
        tags: [],
        expires_at: m.expires_at,
        cause_id: m.cause_id,
        context_trigger: m.context_trigger,
        deliberation_references: m.context_trigger?.startsWith('deliberation:')
          ? [{
              session_id: m.context_trigger.replace('deliberation:', ''),
              role: m.namespace === 'decisions' ? 'consensus_output' : 'agent_position',
            }]
          : [],
        created_at: m.created_at,
      })),
      memory_links: memoryLinksData.rows.map((l: any) => ({
        id: l.id,
        source_memory_id: l.source_memory_id,
        target_memory_id: l.target_memory_id,
        link_type: l.link_type,
        strength: l.strength,
        created_at: l.created_at,
      })),
      rooms: roomsData.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        status: r.status,
        agent_ids: typeof r.agent_ids === 'string' ? JSON.parse(r.agent_ids) : r.agent_ids,
        created_at: r.created_at,
      })),
      deliberations: deliberationsData.rows.map((d: any) => ({
        session_id: d.id,
        room_id: d.room_id,
        topic: d.topic,
        status: d.status,
        model: d.model,
        models_used: typeof d.models_used === 'string' ? JSON.parse(d.models_used) : d.models_used,
        rounds: typeof d.rounds === 'string' ? JSON.parse(d.rounds) : d.rounds,
        consensus: typeof d.consensus === 'string' ? JSON.parse(d.consensus) : d.consensus,
        started_at: d.started_at,
        completed_at: d.completed_at,
      })),
      flows: flowsData.rows.map((f: any) => ({
        id: f.id,
        name: f.name,
        description: f.description,
        agent_ids: typeof f.agent_ids === 'string' ? JSON.parse(f.agent_ids) : f.agent_ids,
        created_at: f.created_at,
      })),
      room_messages: messagesData.rows.map((m: any) => ({
        id: m.id,
        room_id: m.room_id,
        agent_id: m.agent_id,
        agent_name: m.agent_name,
        content: m.content,
        is_decision: m.is_decision,
        created_at: m.created_at,
      })),
      webhooks: webhooksData.rows,
      agent_tokens: tokensData.rows.map((t: any) => ({
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        expires_at: t.expires_at,
        created_at: t.created_at,
      })),
      usage: {
        current_period: currentUsage ? {
          period_start: currentUsage.period_start,
          period_end: currentUsage.period_end,
          deliberations: currentUsage.deliberations,
          rounds: currentUsage.rounds,
          api_calls: currentUsage.api_calls,
          webhook_calls: currentUsage.webhook_calls,
          tokens_used: currentUsage.tokens_used,
        } : null,
        history: usageHistoryData.rows.map((u: any) => ({
          period_start: u.period_start,
          period_end: u.period_end,
          deliberations: u.deliberations,
          rounds: u.rounds,
          api_calls: u.api_calls,
          webhook_calls: u.webhook_calls,
          tokens_used: u.tokens_used,
        })),
      },
    };
  }

  private buildConfidenceHistory(memory: any): any[] {
    const history: any[] = [];
    if (memory.created_at) {
      history.push({ timestamp: memory.created_at, value: 1.0, event: "created" });
    }
    if (memory.confidence !== null && memory.confidence < 1.0) {
      history.push({ timestamp: memory.last_accessed_at ?? memory.created_at, value: memory.confidence, event: "decay" });
    }
    if (memory.last_reinforced_at && memory.reinforcements > 0) {
      history.push({ timestamp: memory.last_reinforced_at, value: memory.confidence, event: "reinforced" });
    }
    return history;
  }

  // ── CSV export for memories ─────────────────────────────────────────────────
  async exportMemoriesCSV(userId: number): Promise<string> {
    const { rows } = await pool.query(
      `SELECT id, content, type, importance, confidence, strength, emotional_valence,
        agent_id, agent_name, namespace, access_count, decay_rate,
        reinforcements, expires_at, cause_id, context_trigger, created_at
        FROM memories WHERE user_id = $1 ORDER BY created_at DESC`, [userId]
    );

    const headers = [
      'id', 'content', 'type', 'importance', 'confidence', 'strength',
      'emotional_valence', 'agent_id', 'agent_name', 'namespace',
      'access_count', 'decay_rate', 'reinforcements', 'expires_at',
      'cause_id', 'context_trigger', 'created_at'
    ];

    const escapeCSV = (val: any): string => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push(headers.map(h => escapeCSV(row[h])).join(','));
    }
    return lines.join('\n');
  }

  // ── Request log retention ──────────────────────────────────────────────────
  async purgeOldRequestLogs(retentionDays: number = 90): Promise<number> {
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const result = await pool.query(
      'DELETE FROM kioku_request_logs WHERE timestamp < $1',
      [cutoff]
    );
    return result.rowCount || 0;
  }

  // ── Per-user resource counts ───────────────────────────────────────────────
  async getUserResourceCounts(userId: number): Promise<{ agents: number; memories: number; rooms: number; flows: number }> {
    const [agentsCount, memoriesCount, roomsCount, flowsCount] = await Promise.all([
      pool.query('SELECT COUNT(*)::int as count FROM agents WHERE user_id = $1', [userId]),
      pool.query('SELECT COUNT(*)::int as count FROM memories WHERE user_id = $1 AND COALESCE(strength, 1) > 0', [userId]),
      pool.query('SELECT COUNT(*)::int as count FROM rooms WHERE user_id = $1', [userId]),
      pool.query('SELECT COUNT(*)::int as count FROM flows WHERE user_id = $1', [userId]),
    ]);
    return {
      agents: agentsCount.rows[0]?.count || 0,
      memories: memoriesCount.rows[0]?.count || 0,
      rooms: roomsCount.rows[0]?.count || 0,
      flows: flowsCount.rows[0]?.count || 0,
    };
  }

  async getUserPlan(userId: number): Promise<string> {
    const result = await pool.query('SELECT plan FROM users WHERE id = $1', [userId]);
    return result.rows[0]?.plan || 'free';
  }

  // ── AI usage tracking ──────────────────────────────────────────────────────
  async checkAIUsage(userId: number, plan: string, dailyCalls: number): Promise<{ allowed: boolean; used: number; limit: number }> {
    // Count today's deliberation-related calls from request_logs
    // kioku_request_logs has no user_id, so we count via the deliberation_sessions table
    const result = await pool.query(
      `SELECT COUNT(*)::int as count FROM kioku_deliberation_sessions
       WHERE user_id = $1 AND started_at > $2`,
      [userId, Date.now() - 86400000]
    );
    const used = result.rows[0]?.count || 0;
    return { allowed: used < dailyCalls, used, limit: dailyCalls };
  }

  // ── Usage metering ─────────────────────────────────────────────────────────
  private getCurrentPeriod(): { start: number; end: number } {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { start: start.getTime(), end: end.getTime() };
  }

  async getOrCreateUsagePeriod(userId: number): Promise<UsageTracking> {
    const { start, end } = this.getCurrentPeriod();
    // Upsert: create if not exists, return existing otherwise
    const { rows } = await pool.query(
      `INSERT INTO usage_tracking (user_id, period_start, period_end, deliberations, rounds, api_calls, webhook_calls, tokens_used, updated_at)
       VALUES ($1, $2, $3, 0, 0, 0, 0, 0, $4)
       ON CONFLICT (user_id, period_start) DO UPDATE SET updated_at = usage_tracking.updated_at
       RETURNING *`,
      [userId, start, end, Date.now()]
    );
    return this.mapUsageRow(rows[0]);
  }

  async incrementUsage(userId: number, field: 'deliberations' | 'rounds' | 'api_calls' | 'webhook_calls' | 'tokens_used', amount: number = 1): Promise<void> {
    const { start, end } = this.getCurrentPeriod();
    await pool.query(
      `INSERT INTO usage_tracking (user_id, period_start, period_end, ${field}, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, period_start) DO UPDATE SET ${field} = usage_tracking.${field} + $4, updated_at = $5`,
      [userId, start, end, amount, Date.now()]
    );
  }

  async getCurrentUsage(userId: number): Promise<UsageTracking> {
    return this.getOrCreateUsagePeriod(userId);
  }

  async getUsageHistory(userId: number, months: number = 6): Promise<UsageTracking[]> {
    const { rows } = await pool.query(
      `SELECT * FROM usage_tracking WHERE user_id = $1 ORDER BY period_start DESC LIMIT $2`,
      [userId, months]
    );
    return rows.map((r: any) => this.mapUsageRow(r));
  }

  private mapUsageRow(row: any): UsageTracking {
    return {
      id: row.id,
      userId: row.user_id,
      periodStart: Number(row.period_start),
      periodEnd: Number(row.period_end),
      deliberations: row.deliberations,
      rounds: row.rounds,
      apiCalls: row.api_calls,
      webhookCalls: row.webhook_calls,
      tokensUsed: row.tokens_used,
      updatedAt: Number(row.updated_at),
    };
  }

  // ── Agent Turns (polling mode queue) ─────────────────────────────────
  async createAgentTurn(data: {
    sessionId: string; agentId: number; roomId: number; userId: number;
    phase: string; round: number; topic: string;
    otherPositions: any[]; memories: any[]; expiresAt: number;
  }) {
    const { rows } = await pool.query(
      `INSERT INTO agent_turns (session_id, agent_id, room_id, user_id, phase, round, topic, other_positions, memories, status, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11)
       RETURNING *`,
      [data.sessionId, data.agentId, data.roomId, data.userId, data.phase, data.round,
       data.topic, JSON.stringify(data.otherPositions), JSON.stringify(data.memories),
       data.expiresAt, Date.now()]
    );
    return this.mapAgentTurnRow(rows[0]);
  }

  async getAgentTurn(turnId: number) {
    const { rows } = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [turnId]);
    return rows[0] ? this.mapAgentTurnRow(rows[0]) : undefined;
  }

  async getPendingTurns(agentId: number) {
    // Expire stale turns first
    await pool.query(
      `UPDATE agent_turns SET status = 'expired' WHERE agent_id = $1 AND status = 'pending' AND expires_at < $2`,
      [agentId, Date.now()]
    );
    const { rows } = await pool.query(
      `SELECT * FROM agent_turns WHERE agent_id = $1 AND status = 'pending' ORDER BY created_at ASC`,
      [agentId]
    );
    return rows.map((r: any) => this.mapAgentTurnRow(r));
  }

  async respondToTurn(turnId: number, agentId: number, response: { position: string; confidence: number; reasoning: string }): Promise<boolean> {
    const result = await pool.query(
      `UPDATE agent_turns SET status = 'responded', response = $1, responded_at = $2
       WHERE id = $3 AND agent_id = $4 AND status = 'pending'
       RETURNING id`,
      [JSON.stringify(response), Date.now(), turnId, agentId]
    );
    return result.rows.length > 0;
  }

  private mapAgentTurnRow(row: any) {
    return {
      id: row.id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      roomId: row.room_id,
      userId: row.user_id,
      phase: row.phase,
      round: row.round,
      topic: row.topic,
      otherPositions: JSON.parse(row.other_positions || '[]'),
      memories: JSON.parse(row.memories || '[]'),
      status: row.status,
      response: row.response ? JSON.parse(row.response) : null,
      respondedAt: row.responded_at ? Number(row.responded_at) : null,
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
    };
  }

  private mapDelibRow(row: any) {
    return {
      sessionId: row.id,
      roomId: row.room_id,
      userId: row.user_id,
      topic: row.topic,
      status: row.status,
      model: row.model,
      modelsUsed: JSON.parse(row.models_used || '[]'),
      rounds: JSON.parse(row.rounds || '[]'),
      consensus: row.consensus ? JSON.parse(row.consensus) : null,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at ? Number(row.completed_at) : null,
      parentDecisionId: row.parent_decision_id || null,
      provenanceChain: JSON.parse(row.provenance_chain || '[]'),
      provenanceChainId: row.provenance_chain_id || null,
      chainDepth: row.chain_depth ?? 0,
      chainMetadata: row.chain_metadata || null,
    };
  }

  // ── Provenance Chain Queries ──────────────────────────────────────────────

  /** Get all descendants (children, grandchildren, etc.) of a decision */
  async getDecisionDescendants(sessionId: string): Promise<any[]> {
    const { rows } = await pool.query(
      `WITH RECURSIVE descendants AS (
        SELECT * FROM kioku_deliberation_sessions WHERE parent_decision_id = $1
        UNION ALL
        SELECT s.* FROM kioku_deliberation_sessions s
        INNER JOIN descendants d ON s.parent_decision_id = d.id
      )
      SELECT * FROM descendants ORDER BY started_at ASC`,
      [sessionId]
    );
    return rows.map((r: any) => this.mapDelibRow(r));
  }

  /** Get all ancestors (parent, grandparent, etc.) of a decision */
  async getDecisionAncestors(sessionId: string): Promise<any[]> {
    const session = await this.getDeliberationSession(sessionId);
    if (!session || !session.provenanceChain || session.provenanceChain.length === 0) return [];
    const chain: string[] = session.provenanceChain;
    if (chain.length === 0) return [];
    const placeholders = chain.map((_: string, i: number) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `SELECT * FROM kioku_deliberation_sessions WHERE id IN (${placeholders}) ORDER BY started_at ASC`,
      chain
    );
    return rows.map((r: any) => this.mapDelibRow(r));
  }

  /** Get direct children of a decision */
  async getDecisionChildren(sessionId: string): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT * FROM kioku_deliberation_sessions WHERE parent_decision_id = $1 ORDER BY started_at ASC`,
      [sessionId]
    );
    return rows.map((r: any) => this.mapDelibRow(r));
  }

  /** Build a provenance chain for a new decision given a parent session ID */
  async buildProvenanceChain(parentSessionId: string): Promise<string[]> {
    const parent = await this.getDeliberationSession(parentSessionId);
    if (!parent) return [];
    const parentChain: string[] = parent.provenanceChain || [];
    // Cap chain length at 50 to prevent unbounded growth
    const chain = [...parentChain, parentSessionId];
    return chain.slice(-50);
  }

  // ── Provenance Chain CRUD (Cross-session Decision Provenance) ────────────

  /** Update a deliberation's provenance chain fields */
  async updateProvenanceFields(sessionId: string, fields: {
    provenanceChainId?: string | null;
    parentDeliberationId?: string | null;
    chainDepth?: number;
    chainMetadata?: object | null;
  }): Promise<void> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (fields.provenanceChainId !== undefined) {
      setClauses.push(`provenance_chain_id = $${idx++}`);
      values.push(fields.provenanceChainId);
    }
    if (fields.parentDeliberationId !== undefined) {
      setClauses.push(`parent_decision_id = $${idx++}`);
      values.push(fields.parentDeliberationId);
    }
    if (fields.chainDepth !== undefined) {
      setClauses.push(`chain_depth = $${idx++}`);
      values.push(fields.chainDepth);
    }
    if (fields.chainMetadata !== undefined) {
      setClauses.push(`chain_metadata = $${idx++}`);
      values.push(fields.chainMetadata ? JSON.stringify(fields.chainMetadata) : null);
    }
    if (setClauses.length === 0) return;
    values.push(sessionId);
    await pool.query(
      `UPDATE kioku_deliberation_sessions SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      values
    );
  }

  /** Get all deliberations in a provenance chain by chain ID, ordered by depth */
  async getDeliberationsByChainId(chainId: string): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT * FROM kioku_deliberation_sessions WHERE provenance_chain_id = $1 ORDER BY chain_depth ASC, started_at ASC`,
      [chainId]
    );
    return rows.map((r: any) => this.mapDelibRow(r));
  }

  /** Get all provenance chains in a room (distinct chain IDs with summaries) */
  async getProvenanceChainsForRoom(roomId: number): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT provenance_chain_id,
              MIN(topic) as topic,
              MIN(started_at) as created_at,
              MAX(COALESCE(completed_at, started_at)) as last_updated,
              MAX(chain_depth) as depth,
              COUNT(*)::int as deliberation_count
       FROM kioku_deliberation_sessions
       WHERE room_id = $1 AND provenance_chain_id IS NOT NULL
       GROUP BY provenance_chain_id
       ORDER BY MAX(COALESCE(completed_at, started_at)) DESC`,
      [roomId]
    );
    return rows.map((r: any) => ({
      chainId: r.provenance_chain_id,
      topic: r.topic,
      createdAt: Number(r.created_at),
      lastUpdated: Number(r.last_updated),
      depth: r.depth,
      deliberationCount: r.deliberation_count,
    }));
  }

  /** Get recent completed deliberations in a room (last 30 days) for auto-linking */
  async getRecentDeliberationsForRoom(roomId: number, daysBack: number = 30): Promise<any[]> {
    const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    const { rows } = await pool.query(
      `SELECT * FROM kioku_deliberation_sessions
       WHERE room_id = $1 AND started_at > $2 AND status = 'completed'
       ORDER BY started_at DESC LIMIT 100`,
      [roomId, cutoff]
    );
    return rows.map((r: any) => this.mapDelibRow(r));
  }

  // ── Stripe Event Idempotency ─────────────────────────────────────────────
  async checkStripeEventExists(stripeEventId: string): Promise<boolean> {
    const result = await pool.query(
      'SELECT 1 FROM stripe_events WHERE stripe_event_id = $1 LIMIT 1',
      [stripeEventId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async insertStripeEvent(stripeEventId: string, type: string): Promise<void> {
    await pool.query(
      'INSERT INTO stripe_events (stripe_event_id, type, status) VALUES ($1, $2, $3) ON CONFLICT (stripe_event_id) DO NOTHING',
      [stripeEventId, type, 'processing']
    );
  }

  async updateStripeEventStatus(stripeEventId: string, status: string, error?: string): Promise<void> {
    await pool.query(
      'UPDATE stripe_events SET status = $1, error = $2 WHERE stripe_event_id = $3',
      [status, error || null, stripeEventId]
    );
  }

  // ── Phase 4: Agent Emotional State CRUD ─────────────────────────────────────

  async getAgentEmotionalState(agentId: number): Promise<any | undefined> {
    const result = await pool.query(
      'SELECT * FROM agent_emotional_state WHERE agent_id = $1',
      [agentId]
    );
    if (result.rows.length === 0) return undefined;
    const r = result.rows[0];
    return {
      id: r.id,
      agentId: r.agent_id,
      userId: r.user_id,
      pleasure: r.pleasure,
      arousal: r.arousal,
      dominance: r.dominance,
      baselinePleasure: r.baseline_pleasure,
      baselineArousal: r.baseline_arousal,
      baselineDominance: r.baseline_dominance,
      emotionLabel: r.emotion_label,
      poignancySum: r.poignancy_sum,
      halfLifeMinutes: r.half_life_minutes,
      lastUpdatedAt: Number(r.last_updated_at),
      createdAt: Number(r.created_at),
    };
  }

  async upsertAgentEmotionalState(agentId: number, userId: number, state: {
    pleasure?: number; arousal?: number; dominance?: number;
    baselinePleasure?: number; baselineArousal?: number; baselineDominance?: number;
    emotionLabel?: string; poignancySum?: number; halfLifeMinutes?: number;
  }): Promise<any> {
    const now = Date.now();
    const result = await pool.query(`
      INSERT INTO agent_emotional_state (agent_id, user_id, pleasure, arousal, dominance,
        baseline_pleasure, baseline_arousal, baseline_dominance, emotion_label,
        poignancy_sum, half_life_minutes, last_updated_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
      ON CONFLICT (agent_id) DO UPDATE SET
        pleasure = COALESCE($3, agent_emotional_state.pleasure),
        arousal = COALESCE($4, agent_emotional_state.arousal),
        dominance = COALESCE($5, agent_emotional_state.dominance),
        baseline_pleasure = COALESCE($6, agent_emotional_state.baseline_pleasure),
        baseline_arousal = COALESCE($7, agent_emotional_state.baseline_arousal),
        baseline_dominance = COALESCE($8, agent_emotional_state.baseline_dominance),
        emotion_label = COALESCE($9, agent_emotional_state.emotion_label),
        poignancy_sum = COALESCE($10, agent_emotional_state.poignancy_sum),
        half_life_minutes = COALESCE($11, agent_emotional_state.half_life_minutes),
        last_updated_at = $12
      RETURNING *
    `, [
      agentId, userId,
      state.pleasure ?? 0.0, state.arousal ?? 0.0, state.dominance ?? 0.0,
      state.baselinePleasure ?? 0.1, state.baselineArousal ?? 0.0, state.baselineDominance ?? 0.2,
      state.emotionLabel ?? 'neutral', state.poignancySum ?? 0.0,
      state.halfLifeMinutes ?? 120, now,
    ]);
    const r = result.rows[0];
    return {
      id: r.id,
      agentId: r.agent_id,
      userId: r.user_id,
      pleasure: r.pleasure,
      arousal: r.arousal,
      dominance: r.dominance,
      baselinePleasure: r.baseline_pleasure,
      baselineArousal: r.baseline_arousal,
      baselineDominance: r.baseline_dominance,
      emotionLabel: r.emotion_label,
      poignancySum: r.poignancy_sum,
      halfLifeMinutes: r.half_life_minutes,
      lastUpdatedAt: Number(r.last_updated_at),
      createdAt: Number(r.created_at),
    };
  }

  // ── Phase 4: Agent Relationships CRUD ───────────────────────────────────────

  async getRelationship(agentId: number, userId: number): Promise<any | undefined> {
    const result = await pool.query(
      'SELECT * FROM agent_relationships WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );
    if (result.rows.length === 0) return undefined;
    const r = result.rows[0];
    return {
      id: r.id,
      agentId: r.agent_id,
      userId: r.user_id,
      trustLevel: r.trust_level,
      familiarity: r.familiarity,
      interactionCount: r.interaction_count,
      sharedReferences: JSON.parse(r.shared_references || '[]'),
      emotionalHistory: JSON.parse(r.emotional_history || '[]'),
      stableOpinions: JSON.parse(r.stable_opinions || '{}'),
      lastInteractionAt: r.last_interaction_at ? Number(r.last_interaction_at) : null,
      createdAt: Number(r.created_at),
    };
  }

  async upsertRelationship(agentId: number, userId: number, updates: {
    trustLevel?: number; familiarity?: number; interactionCount?: number;
    sharedReferences?: any[]; emotionalHistory?: any[]; stableOpinions?: Record<string, any>;
  }): Promise<any> {
    // Bug-fix (2026-04-29): the previous implementation passed `?? 0` /
    // `?? []` for every field and relied on COALESCE($n, existing) in the
    // ON CONFLICT branch. That never preserved existing values because
    // COALESCE only replaces NULL, and `0` / `[]` are both non-NULL — every
    // partial upsert silently zeroed `interaction_count` and `trust_level`,
    // making the agent always see "new (0 conversations)" no matter how
    // many real interactions had happened. We now build the SET clause
    // dynamically and only touch fields the caller actually passed.
    const now = Date.now();
    const setClauses: string[] = ["last_interaction_at = $3"];
    const insertCols: string[] = ["agent_id", "user_id", "last_interaction_at", "created_at"];
    const insertVals: string[] = ["$1", "$2", "$3", "$3"];
    const params: any[] = [agentId, userId, now];
    let i = 4;

    const addField = (col: string, value: any) => {
      params.push(value);
      setClauses.push(`${col} = $${i}`);
      insertCols.push(col);
      insertVals.push(`$${i}`);
      i++;
    };

    if (updates.trustLevel !== undefined)        addField("trust_level", updates.trustLevel);
    if (updates.familiarity !== undefined)       addField("familiarity", updates.familiarity);
    if (updates.interactionCount !== undefined)  addField("interaction_count", updates.interactionCount);
    if (updates.sharedReferences !== undefined)  addField("shared_references", JSON.stringify(updates.sharedReferences));
    if (updates.emotionalHistory !== undefined)  addField("emotional_history", JSON.stringify(updates.emotionalHistory));
    if (updates.stableOpinions !== undefined)    addField("stable_opinions", JSON.stringify(updates.stableOpinions));

    const sql = `
      INSERT INTO agent_relationships (${insertCols.join(", ")})
      VALUES (${insertVals.join(", ")})
      ON CONFLICT (agent_id, user_id) DO UPDATE SET ${setClauses.join(", ")}
      RETURNING *
    `;
    const result = await pool.query(sql, params);
    const r = result.rows[0];
    return {
      id: r.id,
      agentId: r.agent_id,
      userId: r.user_id,
      trustLevel: r.trust_level,
      familiarity: r.familiarity,
      interactionCount: r.interaction_count,
      sharedReferences: JSON.parse(r.shared_references || '[]'),
      emotionalHistory: JSON.parse(r.emotional_history || '[]'),
      stableOpinions: JSON.parse(r.stable_opinions || '{}'),
      lastInteractionAt: r.last_interaction_at ? Number(r.last_interaction_at) : null,
      createdAt: Number(r.created_at),
    };
  }

  async incrementInteraction(agentId: number, userId: number): Promise<void> {
    // R-luca-trust-growth (2026-05-02): trust_level was previously read-only
    // in code — it stayed at 0 forever, so the partner status board always
    // displayed `trust: new` no matter how many turns happened. We now grow
    // trust by +0.01 per turn alongside the existing interaction_count++,
    // capped at 1.0. Matches the +0.01 familiarity growth at
    // deliberation.ts:6758 and structured-deliberation.ts:682.
    // Threshold map (routes.ts:3781):
    //   >0.7 "high", >0.3 "moderate", else "new".
    // → "moderate" at ~30 turns, "high" at ~70 turns. Slow on purpose so
    //   trust is earned over time, not auto-granted on day one.
    const now = Date.now();
    await pool.query(`
      INSERT INTO agent_relationships (agent_id, user_id, trust_level, familiarity, interaction_count, last_interaction_at, created_at)
      VALUES ($1, $2, 0.01, 0.01, 1, $3, $3)
      ON CONFLICT (agent_id, user_id) DO UPDATE SET
        interaction_count   = agent_relationships.interaction_count + 1,
        trust_level         = LEAST(1.0, agent_relationships.trust_level + 0.01),
        last_interaction_at = $3
    `, [agentId, userId, now]);
  }

  // ── Phase 7: Knowledge Domains CRUD ──────────────────────────────────────────

  async createKnowledgeDomain(userId: number, data: { name: string; slug: string; category: string; description?: string }): Promise<KnowledgeDomain> {
    const now = Date.now();
    const [domain] = await db.insert(knowledgeDomains).values({
      userId,
      name: data.name,
      slug: data.slug,
      category: data.category,
      description: data.description || null,
      chunkCount: 0,
      status: "loading",
      createdAt: now,
      updatedAt: now,
    }).returning();
    return domain;
  }

  async getKnowledgeDomain(userId: number, slug: string): Promise<KnowledgeDomain | undefined> {
    const result = await pool.query(
      'SELECT * FROM knowledge_domains WHERE user_id = $1 AND slug = $2 LIMIT 1',
      [userId, slug]
    );
    if (!result.rows[0]) return undefined;
    const r = result.rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      category: r.category,
      chunkCount: r.chunk_count,
      status: r.status,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  async listKnowledgeDomains(userId: number): Promise<KnowledgeDomain[]> {
    const result = await pool.query(
      'SELECT * FROM knowledge_domains WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      category: r.category,
      chunkCount: r.chunk_count,
      status: r.status,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  async updateKnowledgeDomain(userId: number, slug: string, updates: { chunkCount?: number; status?: string; updatedAt?: number }): Promise<void> {
    const sets: string[] = [];
    const params: any[] = [userId, slug];
    let idx = 3;
    if (updates.chunkCount !== undefined) {
      sets.push(`chunk_count = $${idx++}`);
      params.push(updates.chunkCount);
    }
    if (updates.status !== undefined) {
      sets.push(`status = $${idx++}`);
      params.push(updates.status);
    }
    if (updates.updatedAt !== undefined) {
      sets.push(`updated_at = $${idx++}`);
      params.push(updates.updatedAt);
    }
    if (sets.length === 0) return;
    await pool.query(
      `UPDATE knowledge_domains SET ${sets.join(', ')} WHERE user_id = $1 AND slug = $2`,
      params
    );
  }

  // ── Phase 8: Aesthetic Preferences CRUD ───────────────────────────────────────

  async savePreference(userId: number, agentId: number, data: {
    category: string; item: string; reaction: string; context?: string; tags?: string[];
  }): Promise<any> {
    const now = Date.now();
    const tagsJson = JSON.stringify(data.tags || []);
    const { rows } = await pool.query(
      `INSERT INTO aesthetic_preferences (user_id, agent_id, category, item, reaction, context, tags, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, agentId, data.category, data.item, data.reaction, data.context || null, tagsJson, now]
    );
    const r = rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      agentId: r.agent_id,
      category: r.category,
      item: r.item,
      reaction: r.reaction,
      context: r.context,
      tags: JSON.parse(r.tags || '[]'),
      createdAt: Number(r.created_at),
    };
  }

  async getPreferences(userId: number, category?: string, limit: number = 50): Promise<any[]> {
    let query = 'SELECT * FROM aesthetic_preferences WHERE user_id = $1';
    const params: any[] = [userId];
    let idx = 2;
    if (category) {
      query += ` AND category = $${idx++}`;
      params.push(category);
    }
    query += ` ORDER BY created_at DESC LIMIT $${idx}`;
    params.push(limit);
    const { rows } = await pool.query(query, params);
    return rows.map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      agentId: r.agent_id,
      category: r.category,
      item: r.item,
      reaction: r.reaction,
      context: r.context,
      tags: JSON.parse(r.tags || '[]'),
      createdAt: Number(r.created_at),
    }));
  }

  async getPreferenceProfile(userId: number): Promise<any> {
    const { rows } = await pool.query(
      'SELECT * FROM aesthetic_preferences WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200',
      [userId]
    );
    const categories: Record<string, { loves: string[]; dislikes: string[]; dominantTags: string[] }> = {};
    const tagCounts: Record<string, number> = {};

    for (const r of rows) {
      const cat = r.category;
      if (!categories[cat]) categories[cat] = { loves: [], dislikes: [], dominantTags: [] };
      const tags: string[] = JSON.parse(r.tags || '[]');
      for (const t of tags) tagCounts[t] = (tagCounts[t] || 0) + 1;

      if (r.reaction === 'love' || r.reaction === 'like') {
        categories[cat].loves.push(r.item);
      } else if (r.reaction === 'dislike' || r.reaction === 'hate') {
        categories[cat].dislikes.push(r.item);
      }
    }

    // Compute dominant tags per category
    for (const cat of Object.keys(categories)) {
      const catRows = rows.filter((r: any) => r.category === cat);
      const catTagCounts: Record<string, number> = {};
      for (const r of catRows) {
        const tags: string[] = JSON.parse(r.tags || '[]');
        for (const t of tags) catTagCounts[t] = (catTagCounts[t] || 0) + 1;
      }
      categories[cat].dominantTags = Object.entries(catTagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag]) => tag);
      // Deduplicate loves/dislikes
      categories[cat].loves = [...new Set(categories[cat].loves)].slice(0, 10);
      categories[cat].dislikes = [...new Set(categories[cat].dislikes)].slice(0, 10);
    }

    return { categories, totalPreferences: rows.length };
  }

  async deleteKnowledgeDomain(userId: number, slug: string): Promise<boolean> {
    // Delete all memories in this knowledge namespace
    await pool.query(
      `DELETE FROM memories WHERE user_id = $1 AND namespace = $2`,
      [userId, `knowledge:${slug}`]
    );
    // Delete the domain
    const result = await pool.query(
      'DELETE FROM knowledge_domains WHERE user_id = $1 AND slug = $2 RETURNING id',
      [userId, slug]
    );
    return result.rows.length > 0;
  }

  // ── Scheduled Tasks CRUD ────────────────────────────────────────────────────

  async createScheduledTask(data: {
    userId: number; agentId: number; roomId?: number | null;
    title: string; description?: string | null;
    taskType: string; cronExpression?: string | null;
    scheduledAt?: number | null; timezone?: string;
    status?: string; nextRunAt?: number | null;
    maxRuns?: number | null;
    actionType?: string; actionPayload?: string | null;
  }): Promise<any> {
    const now = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO scheduled_tasks
        (user_id, agent_id, room_id, title, description, task_type, cron_expression,
         scheduled_at, timezone, status, next_run_at, max_runs, action_type, action_payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       RETURNING *`,
      [
        data.userId, data.agentId, data.roomId || null,
        data.title, data.description || null,
        data.taskType, data.cronExpression || null,
        data.scheduledAt || null, data.timezone || 'UTC',
        data.status || 'active', data.nextRunAt || data.scheduledAt || null,
        data.maxRuns || null,
        data.actionType || 'message', data.actionPayload || null,
        now,
      ]
    );
    return this.mapScheduledTaskRow(rows[0]);
  }

  async getScheduledTasks(userId: number): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_tasks WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return rows.map((r: any) => this.mapScheduledTaskRow(r));
  }

  async getScheduledTaskById(taskId: number, userId: number): Promise<any | undefined> {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_tasks WHERE id = $1 AND user_id = $2`,
      [taskId, userId]
    );
    return rows[0] ? this.mapScheduledTaskRow(rows[0]) : undefined;
  }

  async updateScheduledTask(taskId: number, userId: number, updates: Record<string, any>): Promise<any | undefined> {
    const allowed = ['title', 'description', 'status', 'cron_expression', 'scheduled_at',
      'timezone', 'next_run_at', 'max_runs', 'action_type', 'action_payload'];
    const colMap: Record<string, string> = {
      title: 'title', description: 'description', status: 'status',
      cronExpression: 'cron_expression', cron_expression: 'cron_expression',
      scheduledAt: 'scheduled_at', scheduled_at: 'scheduled_at',
      timezone: 'timezone', nextRunAt: 'next_run_at', next_run_at: 'next_run_at',
      maxRuns: 'max_runs', max_runs: 'max_runs',
      actionType: 'action_type', action_type: 'action_type',
      actionPayload: 'action_payload', action_payload: 'action_payload',
    };
    const sets: string[] = [];
    const params: any[] = [taskId, userId];
    let idx = 3;
    for (const [key, val] of Object.entries(updates)) {
      const col = colMap[key];
      if (col && allowed.includes(col)) {
        sets.push(`${col} = $${idx++}`);
        params.push(val);
      }
    }
    if (sets.length === 0) return this.getScheduledTaskById(taskId, userId);
    sets.push(`updated_at = $${idx++}`);
    params.push(Date.now());
    const { rows } = await pool.query(
      `UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
      params
    );
    return rows[0] ? this.mapScheduledTaskRow(rows[0]) : undefined;
  }

  async deleteScheduledTask(taskId: number, userId: number): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM scheduled_tasks WHERE id = $1 AND user_id = $2 RETURNING id`,
      [taskId, userId]
    );
    return result.rows.length > 0;
  }

  async getDueScheduledTasks(): Promise<any[]> {
    const now = Date.now();
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_tasks WHERE next_run_at <= $1 AND status = 'active'`,
      [now]
    );
    return rows.map((r: any) => this.mapScheduledTaskRow(r));
  }

  async markTaskRun(taskId: number, nextRunAt?: number | null): Promise<void> {
    const now = Date.now();
    if (nextRunAt) {
      // Recurring task: update run count and next_run_at
      await pool.query(
        `UPDATE scheduled_tasks SET last_run_at = $1, run_count = run_count + 1, next_run_at = $2, updated_at = $1 WHERE id = $3`,
        [now, nextRunAt, taskId]
      );
      // Check max_runs
      await pool.query(
        `UPDATE scheduled_tasks SET status = 'completed' WHERE id = $1 AND max_runs IS NOT NULL AND run_count >= max_runs`,
        [taskId]
      );
    } else {
      // One-time/reminder: mark as completed
      await pool.query(
        `UPDATE scheduled_tasks SET last_run_at = $1, run_count = run_count + 1, status = 'completed', updated_at = $1 WHERE id = $2`,
        [now, taskId]
      );
    }
  }

  private mapScheduledTaskRow(row: any): any {
    return {
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      roomId: row.room_id,
      title: row.title,
      description: row.description,
      taskType: row.task_type,
      cronExpression: row.cron_expression,
      scheduledAt: row.scheduled_at ? Number(row.scheduled_at) : null,
      timezone: row.timezone,
      status: row.status,
      lastRunAt: row.last_run_at ? Number(row.last_run_at) : null,
      nextRunAt: row.next_run_at ? Number(row.next_run_at) : null,
      runCount: row.run_count,
      maxRuns: row.max_runs,
      actionType: row.action_type,
      actionPayload: row.action_payload,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // ── Gallery ──────────────────────────────────────────────────────────────────
  async addGalleryItem(item: { userId: number; agentId?: number | null; type: string; title?: string; contentUrl?: string; contentText?: string; prompt?: string; metadata?: any }): Promise<any> {
    const now = Date.now();
    const result = await pool.query(
      `INSERT INTO gallery (user_id, agent_id, type, title, content_url, content_text, prompt, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [item.userId, item.agentId || null, item.type, item.title || null, item.contentUrl || null, item.contentText || null, item.prompt || null, JSON.stringify(item.metadata || {}), now]
    );
    return result.rows[0];
  }

  async getGalleryItems(userId: number, type?: string, limit = 50, offset = 0): Promise<any[]> {
    if (type) {
      const result = await pool.query(
        `SELECT * FROM gallery WHERE user_id = $1 AND type = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [userId, type, limit, offset]
      );
      return result.rows;
    }
    const result = await pool.query(
      `SELECT * FROM gallery WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return result.rows;
  }
}

export const storage = new Storage();

// Bootstrap demo user on startup
export async function initDemoUser() {
  const existing = await storage.getUserByEmail("demo@kioku.ai");
  if (!existing) {
    await storage.createUser({ email: "demo@kioku.ai", name: "Demo User", plan: "dev" });
  }
}
