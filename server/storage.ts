import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, desc, ilike, or, sql } from "drizzle-orm";
import {
  users, agents, memories, memoryLinks, flows, rooms, roomMessages, logs, magicTokens, usageTracking,
  type User, type InsertUser,
  type Agent, type InsertAgent,
  type Memory, type InsertMemory,
  type MemoryLink,
  type Flow, type InsertFlow,
  type Room, type InsertRoom,
  type RoomMessage, type InsertRoomMessage,
  type Log, type InsertLog,
  type MagicToken, type InsertMagicToken,
  type UsageTracking,
} from "@shared/schema";
import { randomBytes, createHash } from "crypto";
import { computeDecayedStrength, computeDecayedConfidence } from "./memory-decay";

// ── DB connection ─────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/kioku";
const sslConfig = dbUrl.includes('neon.tech')
  ? { ssl: { rejectUnauthorized: true } }  // Neon uses valid public CA certs
  : (process.env.NODE_ENV === 'production'
    ? { ssl: { rejectUnauthorized: true } }
    : (dbUrl.includes('sslmode=require') ? { ssl: { rejectUnauthorized: true } } : {}));
export const pool = new Pool({
  connectionString: dbUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ...sslConfig,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
  // Don't crash — pool will auto-reconnect on next query
});

export const db = drizzle(pool);

// ── Schema init (idempotent) ──────────────────────────────────────────────────
export async function initDb() {
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
  // Set owner role for user ID 10 (idempotent)
  await pool.query(`UPDATE users SET role = 'owner' WHERE id = 10 AND role != 'owner'`);

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
  addRoomMessage(data: InsertRoomMessage, userId?: number): Promise<RoomMessage | null>;

  getLogs(userId: number, limit?: number): Promise<Log[]>;
  addLog(data: InsertLog): Promise<Log>;

  getStats(userId: number): Promise<{ totalMemories: number; totalOps: number; avgLatency: number; activeAgents: number }>;
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

      let sqlQuery = `
        SELECT *,
          1 - (embedding_vec <=> $1::vector) as similarity,
          COALESCE(strength, 1.0) as effective_strength
        FROM memories
        WHERE user_id = $2
          AND embedding_vec IS NOT NULL
      `;
      const params: any[] = [embeddingStr, userId];
      let paramIdx = 3;

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
          const combinedScore = r.similarity * 0.7 + (r.importance ?? 0.5) * 0.3;
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
    let sqlQuery = 'SELECT * FROM memories WHERE user_id = $1 AND (content ILIKE $2 OR agent_name ILIKE $2)';
    const params: any[] = [userId, `%${query}%`];
    let idx = 3;
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

    // Write embedding_vec for pgvector search
    if (data.embedding) {
      try {
        const parsed = typeof data.embedding === 'string' ? JSON.parse(data.embedding) : data.embedding;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const vecStr = `[${parsed.join(',')}]`;
          await pool.query(
            'UPDATE memories SET embedding_vec = $1::vector WHERE id = $2',
            [vecStr, mem.id]
          );
        }
      } catch { /* embedding_vec will be null — text search fallback */ }
    }

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
    const [result] = await db.insert(roomMessages).values({ ...data, createdAt: Date.now() }).returning();
    return result;
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
  }) {
    await pool.query(
      `INSERT INTO kioku_deliberation_sessions (id, room_id, user_id, topic, status, model, models_used, rounds, consensus, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         models_used = EXCLUDED.models_used,
         rounds = EXCLUDED.rounds,
         consensus = EXCLUDED.consensus,
         completed_at = EXCLUDED.completed_at`,
      [
        session.id, session.roomId, session.userId, session.topic,
        session.status, session.model,
        JSON.stringify(session.modelsUsed),
        JSON.stringify(session.rounds),
        session.consensus ? JSON.stringify(session.consensus) : null,
        session.startedAt, session.completedAt,
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
    // 2. Memories
    await pool.query('DELETE FROM memories WHERE user_id = $1', [userId]);
    // 3. Room messages (references rooms)
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
    };
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
}

export const storage = new Storage();

// Bootstrap demo user on startup
export async function initDemoUser() {
  const existing = await storage.getUserByEmail("demo@kioku.ai");
  if (!existing) {
    await storage.createUser({ email: "demo@kioku.ai", name: "Demo User", plan: "dev" });
  }
}
