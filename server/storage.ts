import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, and } from "drizzle-orm";
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
import { randomBytes, createHash } from "crypto";

const sqlite = new Database("kioku-dashboard.db");
export const db = drizzle(sqlite);

// Migrate: add agent_roles column if not exists
try { sqlite.exec("ALTER TABLE flows ADD COLUMN agent_roles TEXT NOT NULL DEFAULT '{}'"); } catch {}

// Init tables
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    company TEXT,
    plan TEXT NOT NULL DEFAULT 'dev',
    billing_cycle TEXT NOT NULL DEFAULT 'monthly',
    api_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS magic_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT NOT NULL DEFAULT '#D4AF37',
    status TEXT NOT NULL DEFAULT 'idle',
    memories_count INTEGER NOT NULL DEFAULT 0,
    last_active_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    agent_id INTEGER,
    agent_name TEXT,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'semantic',
    importance REAL NOT NULL DEFAULT 0.5,
    namespace TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    positions TEXT NOT NULL DEFAULT '{}',
    agent_roles TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  -- Add agent_roles column if upgrading existing DB
  -- (safe to run multiple times — IF NOT EXISTS handles it)
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'standby',
    agent_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    agent_id INTEGER,
    agent_name TEXT NOT NULL,
    agent_color TEXT NOT NULL DEFAULT '#D4AF37',
    content TEXT NOT NULL,
    is_decision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    agent_name TEXT,
    agent_color TEXT NOT NULL DEFAULT '#D4AF37',
    operation TEXT NOT NULL,
    detail TEXT NOT NULL,
    latency_ms INTEGER,
    created_at INTEGER NOT NULL
  );
`);

function generateApiKey(): string {
  return "kk_" + randomBytes(24).toString("hex");
}

export interface IStorage {
  // Users
  getUserByEmail(email: string): User | undefined;
  getUserByApiKey(apiKey: string): User | undefined;
  getUserById(id: number): User | undefined;
  createUser(data: { email: string; name: string; company?: string; plan?: string }): User;
  updateUserPlan(id: number, plan: string, billingCycle: string): User | undefined;

  // Magic tokens
  createMagicToken(email: string): string;
  verifyMagicToken(token: string): string | null; // returns email or null

  // Agents
  getAgents(userId: number): Agent[];
  getAgent(id: number): Agent | undefined;
  createAgent(data: InsertAgent): Agent;
  updateAgentStatus(id: number, status: string): void;
  toggleAgent(id: number, enabled: boolean): void;
  deleteAgent(id: number): void;

  // Memories
  getMemories(userId: number, limit?: number): Memory[];
  searchMemories(userId: number, query: string): Memory[];
  createMemory(data: InsertMemory): Memory;
  deleteMemory(id: number): void;
  getMemoriesCount(userId: number): number;

  // Flows
  getFlows(userId: number): Flow[];
  getFlow(id: number): Flow | undefined;
  createFlow(data: InsertFlow): Flow;
  updateFlow(id: number, data: Partial<{ name: string; description: string; agentIds: string; positions: string; agentRoles: string }>): Flow | undefined;
  deleteFlow(id: number): void;

  // Rooms
  getRooms(userId: number): Room[];
  getRoom(id: number): Room | undefined;
  createRoom(data: InsertRoom): Room;
  updateRoom(id: number, data: Partial<{ name: string; description: string; status: string; agentIds: string }>): Room | undefined;
  deleteRoom(id: number): void;

  // Room messages
  getRoomMessages(roomId: number): RoomMessage[];
  addRoomMessage(data: InsertRoomMessage): RoomMessage;

  // Logs
  getLogs(userId: number, limit?: number): Log[];
  addLog(data: InsertLog): Log;

  // Stats
  getStats(userId: number): { totalMemories: number; totalOps: number; avgLatency: number; activeAgents: number };
}

export class Storage implements IStorage {
  getUserByEmail(email: string) {
    return db.select().from(users).where(eq(users.email, email)).get();
  }
  getUserByApiKey(apiKey: string) {
    return db.select().from(users).where(eq(users.apiKey, apiKey)).get();
  }
  getUserById(id: number) {
    return db.select().from(users).where(eq(users.id, id)).get();
  }
  createUser(data: { email: string; name: string; company?: string; plan?: string }): User {
    const existing = this.getUserByEmail(data.email);
    if (existing) return existing;
    const apiKey = generateApiKey();
    const now = Date.now();
    const result = db.insert(users).values({
      email: data.email,
      name: data.name,
      company: data.company ?? null,
      plan: data.plan ?? "dev",
      billingCycle: "monthly",
      apiKey,
      createdAt: now,
    }).returning().get();
    return result;
  }
  updateUserPlan(id: number, plan: string, billingCycle: string) {
    return db.update(users).set({ plan, billingCycle }).where(eq(users.id, id)).returning().get();
  }

  createMagicToken(email: string): string {
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 min
    db.insert(magicTokens).values({ email, token, expiresAt, used: 0 }).run();
    return token;
  }
  verifyMagicToken(token: string): string | null {
    const record = db.select().from(magicTokens).where(eq(magicTokens.token, token)).get();
    if (!record) return null;
    if (record.used) return null;
    if (Date.now() > record.expiresAt) return null;
    db.update(magicTokens).set({ used: 1 }).where(eq(magicTokens.token, token)).run();
    return record.email;
  }

  getAgents(userId: number) {
    return db.select().from(agents).where(eq(agents.userId, userId)).all();
  }
  getAgent(id: number) {
    return db.select().from(agents).where(eq(agents.id, id)).get();
  }
  createAgent(data: InsertAgent): Agent {
    return db.insert(agents).values({ ...data, createdAt: Date.now() }).returning().get();
  }
  updateAgentStatus(id: number, status: string) {
    db.update(agents).set({ status, lastActiveAt: Date.now() }).where(eq(agents.id, id)).run();
  }
  toggleAgent(id: number, enabled: boolean) {
    db.update(agents).set({ enabled: enabled ? 1 : 0 }).where(eq(agents.id, id)).run();
  }
  deleteAgent(id: number) {
    db.delete(agents).where(eq(agents.id, id)).run();
  }

  getMemories(userId: number, limit = 100) {
    return db.select().from(memories).where(eq(memories.userId, userId)).orderBy(desc(memories.createdAt)).limit(limit).all();
  }
  searchMemories(userId: number, query: string) {
    const all = this.getMemories(userId, 500);
    const q = query.toLowerCase();
    return all.filter(m => m.content.toLowerCase().includes(q) || (m.agentName ?? "").toLowerCase().includes(q));
  }
  createMemory(data: InsertMemory): Memory {
    const mem = db.insert(memories).values({ ...data, createdAt: Date.now() }).returning().get();
    // update agent count
    if (data.agentId) {
      const agent = this.getAgent(data.agentId);
      if (agent) {
        db.update(agents).set({ memoriesCount: agent.memoriesCount + 1, lastActiveAt: Date.now(), status: "online" }).where(eq(agents.id, data.agentId)).run();
      }
    }
    return mem;
  }
  deleteMemory(id: number) {
    db.delete(memories).where(eq(memories.id, id)).run();
  }
  getMemoriesCount(userId: number) {
    return this.getMemories(userId, 10000).length;
  }

  getFlows(userId: number) {
    return db.select().from(flows).where(eq(flows.userId, userId)).all();
  }
  getFlow(id: number) {
    return db.select().from(flows).where(eq(flows.id, id)).get();
  }
  createFlow(data: InsertFlow): Flow {
    return db.insert(flows).values({ ...data, createdAt: Date.now() }).returning().get();
  }
  updateFlow(id: number, data: Partial<{ name: string; description: string; agentIds: string; positions: string; agentRoles: string }>) {
    return db.update(flows).set(data).where(eq(flows.id, id)).returning().get();
  }
  deleteFlow(id: number) {
    db.delete(flows).where(eq(flows.id, id)).run();
  }

  getRooms(userId: number) {
    return db.select().from(rooms).where(eq(rooms.userId, userId)).all();
  }
  getRoom(id: number) {
    return db.select().from(rooms).where(eq(rooms.id, id)).get();
  }
  createRoom(data: InsertRoom): Room {
    return db.insert(rooms).values({ ...data, createdAt: Date.now() }).returning().get();
  }
  updateRoom(id: number, data: Partial<{ name: string; description: string; status: string; agentIds: string }>) {
    return db.update(rooms).set(data).where(eq(rooms.id, id)).returning().get();
  }
  deleteRoom(id: number) {
    db.delete(rooms).where(eq(rooms.id, id)).run();
  }

  getRoomMessages(roomId: number) {
    return db.select().from(roomMessages).where(eq(roomMessages.roomId, roomId)).orderBy(roomMessages.createdAt).all();
  }
  addRoomMessage(data: InsertRoomMessage): RoomMessage {
    return db.insert(roomMessages).values({ ...data, createdAt: Date.now() }).returning().get();
  }

  getLogs(userId: number, limit = 50) {
    return db.select().from(logs).where(eq(logs.userId, userId)).orderBy(desc(logs.createdAt)).limit(limit).all();
  }
  addLog(data: InsertLog): Log {
    return db.insert(logs).values({ ...data, createdAt: Date.now() }).returning().get();
  }

  getStats(userId: number) {
    const userAgents = this.getAgents(userId);
    const totalMemories = this.getMemoriesCount(userId);
    const userLogs = this.getLogs(userId, 1000);
    const totalOps = userLogs.length;
    const latencies = userLogs.filter(l => l.latencyMs).map(l => l.latencyMs!);
    const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const activeAgents = userAgents.filter(a => a.status === "online" && a.enabled).length;
    return { totalMemories, totalOps, avgLatency, activeAgents };
  }

}

export const storage = new Storage();

// Bootstrap demo user — clean slate, no seed data
(function initDemoUser() {
  const existing = storage.getUserByEmail("demo@kioku.ai");
  if (!existing) {
    storage.createUser({ email: "demo@kioku.ai", name: "Demo User", plan: "dev" });
    console.log("[KIOKU] Demo user created (clean)");
  }
})();
