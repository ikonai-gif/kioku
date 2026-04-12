import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, desc, ilike, or, sql } from "drizzle-orm";
import {
  users, agents, memories, flows, rooms, roomMessages, logs, magicTokens,
  type User, type InsertUser,
  type Agent, type InsertAgent,
  type Memory, type InsertMemory,
  type Flow, type InsertFlow,
  type Room, type InsertRoom,
  type RoomMessage, type InsertRoomMessage,
  type Log, type InsertLog,
  type MagicToken, type InsertMagicToken,
} from "@shared/schema";
import { randomBytes } from "crypto";

// ── DB connection ─────────────────────────────────────────────────────────────
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/kioku",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
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
}

function generateApiKey(): string {
  return "kk_" + randomBytes(24).toString("hex");
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
  updateAgent(id: number, data: Partial<{ name: string; description: string; color: string; model: string; role: string }>): Promise<void>;
  updateAgentStatus(id: number, status: string): Promise<void>;
  toggleAgent(id: number, enabled: boolean): Promise<void>;
  deleteAgent(id: number): Promise<void>;

  getMemories(userId: number, limit?: number): Promise<Memory[]>;
  searchMemories(userId: number, query: string, queryEmbedding?: number[]): Promise<Memory[]>;
  createMemory(data: InsertMemory): Promise<Memory>;
  deleteMemory(id: number): Promise<void>;
  getMemoriesCount(userId: number): Promise<number>;

  getFlows(userId: number): Promise<Flow[]>;
  getFlow(id: number): Promise<Flow | undefined>;
  createFlow(data: InsertFlow): Promise<Flow>;
  updateFlow(id: number, data: Partial<{ name: string; description: string; agentIds: string; positions: string; agentRoles: string }>): Promise<Flow | undefined>;
  deleteFlow(id: number): Promise<void>;

  getRooms(userId: number): Promise<Room[]>;
  getRoom(id: number): Promise<Room | undefined>;
  createRoom(data: InsertRoom): Promise<Room>;
  updateRoom(id: number, data: Partial<{ name: string; description: string; status: string; agentIds: string }>): Promise<Room | undefined>;
  deleteRoom(id: number): Promise<void>;

  getRoomMessages(roomId: number): Promise<RoomMessage[]>;
  addRoomMessage(data: InsertRoomMessage): Promise<RoomMessage>;

  getLogs(userId: number, limit?: number): Promise<Log[]>;
  addLog(data: InsertLog): Promise<Log>;

  getStats(userId: number): Promise<{ totalMemories: number; totalOps: number; avgLatency: number; activeAgents: number }>;
}

export class Storage implements IStorage {

  // ── Users ──────────────────────────────────────────────────────────────────
  async getUserByEmail(email: string) {
    return db.select().from(users).where(eq(users.email, email)).limit(1).then(r => r[0]);
  }
  async getUserByApiKey(apiKey: string) {
    return db.select().from(users).where(eq(users.apiKey, apiKey)).limit(1).then(r => r[0]);
  }
  async getUserById(id: number) {
    return db.select().from(users).where(eq(users.id, id)).limit(1).then(r => r[0]);
  }
  async createUser(data: { email: string; name: string; company?: string; plan?: string }): Promise<User> {
    const existing = await this.getUserByEmail(data.email);
    if (existing) return existing;
    const apiKey = generateApiKey();
    const [result] = await db.insert(users).values({
      email: data.email,
      name: data.name,
      company: data.company ?? null,
      plan: data.plan ?? "dev",
      billingCycle: "monthly",
      apiKey,
      createdAt: Date.now(),
    }).returning();
    return result;
  }
  async updateUserPlan(id: number, plan: string, billingCycle: string) {
    return db.update(users).set({ plan, billingCycle }).where(eq(users.id, id)).returning().then(r => r[0]);
  }
  async updateStripeCustomerId(id: number, stripeCustomerId: string) {
    await db.update(users).set({ stripeCustomerId }).where(eq(users.id, id));
  }
  async rotateApiKey(id: number) {
    const newKey = generateApiKey();
    return db.update(users).set({ apiKey: newKey }).where(eq(users.id, id)).returning().then(r => r[0]);
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
  async updateAgent(id: number, data: Partial<{ name: string; description: string; color: string; model: string; role: string }>) {
    await db.update(agents).set(data).where(eq(agents.id, id));
  }
  async updateAgentStatus(id: number, status: string) {
    await db.update(agents).set({ status, lastActiveAt: Date.now() }).where(eq(agents.id, id));
  }
  async toggleAgent(id: number, enabled: boolean) {
    await db.update(agents).set({ enabled }).where(eq(agents.id, id));
  }
  async deleteAgent(id: number) {
    await db.delete(agents).where(eq(agents.id, id));
  }

  // ── Memories ───────────────────────────────────────────────────────────────
  async getMemories(userId: number, limit = 100) {
    return db.select().from(memories).where(eq(memories.userId, userId))
      .orderBy(desc(memories.createdAt)).limit(limit);
  }
  async searchMemories(userId: number, query: string, queryEmbedding?: number[]) {
    const all = await this.getMemories(userId, 1000);

    // Semantic search if embedding provided
    if (queryEmbedding && queryEmbedding.length > 0) {
      const scored = all
        .filter(m => m.embedding)
        .map(m => {
          try {
            const emb = JSON.parse(m.embedding!) as number[];
            return { m, score: cosineSimilarity(queryEmbedding, emb) };
          } catch { return { m, score: 0 }; }
        })
        .sort((a, b) => b.score - a.score)
        .filter(x => x.score > 0.7)
        .map(x => x.m);

      // Fallback to text if no semantic results
      if (scored.length > 0) return scored.slice(0, 20);
    }

    // Text fallback
    const q = query.toLowerCase();
    return all.filter(m =>
      m.content.toLowerCase().includes(q) ||
      (m.agentName ?? "").toLowerCase().includes(q)
    ).slice(0, 20);
  }
  async createMemory(data: InsertMemory): Promise<Memory> {
    const [mem] = await db.insert(memories).values({ ...data, createdAt: Date.now() }).returning();
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
  async deleteMemory(id: number) {
    await db.delete(memories).where(eq(memories.id, id));
  }
  async getMemoriesCount(userId: number) {
    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM memories WHERE user_id = $1", [userId]
    );
    return parseInt(result.rows[0]?.count ?? "0");
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
  async updateFlow(id: number, data: Partial<{ name: string; description: string; agentIds: string; positions: string; agentRoles: string }>) {
    return db.update(flows).set(data).where(eq(flows.id, id)).returning().then(r => r[0]);
  }
  async deleteFlow(id: number) {
    await db.delete(flows).where(eq(flows.id, id));
  }

  // ── Rooms ──────────────────────────────────────────────────────────────────
  async getRooms(userId: number) {
    return db.select().from(rooms).where(eq(rooms.userId, userId));
  }
  async getRoom(id: number) {
    return db.select().from(rooms).where(eq(rooms.id, id)).limit(1).then(r => r[0]);
  }
  async createRoom(data: InsertRoom): Promise<Room> {
    const [result] = await db.insert(rooms).values({ ...data, createdAt: Date.now() }).returning();
    return result;
  }
  async updateRoom(id: number, data: Partial<{ name: string; description: string; status: string; agentIds: string }>) {
    return db.update(rooms).set(data).where(eq(rooms.id, id)).returning().then(r => r[0]);
  }
  async deleteRoom(id: number) {
    await db.delete(rooms).where(eq(rooms.id, id));
  }

  // ── Room Messages ──────────────────────────────────────────────────────────
  async getRoomMessages(roomId: number) {
    return db.select().from(roomMessages).where(eq(roomMessages.roomId, roomId))
      .orderBy(roomMessages.createdAt);
  }
  async addRoomMessage(data: InsertRoomMessage): Promise<RoomMessage> {
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

  async getWebhook(agentId: number) {
    const { rows } = await pool.query(
      `SELECT * FROM kioku_webhooks WHERE agent_id = $1 AND active = TRUE`, [agentId]
    );
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

  async deleteWebhook(agentId: number) {
    await pool.query(`DELETE FROM kioku_webhooks WHERE agent_id = $1`, [agentId]);
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
}

export const storage = new Storage();

// Bootstrap demo user on startup
export async function initDemoUser() {
  const existing = await storage.getUserByEmail("demo@kioku.ai");
  if (!existing) {
    await storage.createUser({ email: "demo@kioku.ai", name: "Demo User", plan: "dev" });
  }
}
