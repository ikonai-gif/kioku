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
    created_at INTEGER NOT NULL
  );
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
  updateFlow(id: number, data: Partial<{ name: string; description: string; agentIds: string; positions: string }>): Flow | undefined;
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
    // Seed demo data for new user
    this._seedDemoData(result.id);
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
  updateFlow(id: number, data: Partial<{ name: string; description: string; agentIds: string; positions: string }>) {
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

  private _seedDemoData(userId: number) {
    const now = Date.now();
    // Demo agents — generic names, user can rename
    const a1 = db.insert(agents).values({ userId, name: "Agent 1", description: "General-purpose assistant", color: "#D4AF37", status: "online", memoriesCount: 124, lastActiveAt: now - 120000, enabled: 1, createdAt: now - 86400000 }).returning().get();
    const a2 = db.insert(agents).values({ userId, name: "Agent 2", description: "Data & analytics", color: "#3B82F6", status: "online", memoriesCount: 89, lastActiveAt: now - 480000, enabled: 1, createdAt: now - 86400000 }).returning().get();
    const a3 = db.insert(agents).values({ userId, name: "Agent 3", description: "Content & communication", color: "#A855F7", status: "idle", memoriesCount: 34, lastActiveAt: now - 3600000, enabled: 1, createdAt: now - 86400000 }).returning().get();
    const aO = db.insert(agents).values({ userId, name: "Agent O", description: "Orchestrator — coordinates other agents", color: "#10B981", status: "online", memoriesCount: 56, lastActiveAt: now - 60000, enabled: 1, createdAt: now - 86400000 }).returning().get();

    // Demo memories
    const memData = [
      { agentId: a1.id, agentName: "Agent 1", content: "User prefers dark mode and compact layout in dashboard", type: "semantic", importance: 0.8 },
      { agentId: a1.id, agentName: "Agent 1", content: "Customer upgraded from Starter to Team plan", type: "episodic", importance: 0.9 },
      { agentId: a2.id, agentName: "Agent 2", content: "Q2 revenue projections show 23% growth in enterprise segment", type: "semantic", importance: 0.85 },
      { agentId: a2.id, agentName: "Agent 2", content: "Procedure: always validate API key before processing memory writes", type: "procedural", importance: 0.95 },
      { agentId: a3.id, agentName: "Agent 3", content: "Brand voice: professional, concise, no filler phrases", type: "procedural", importance: 0.9 },
      { agentId: a1.id, agentName: "Agent 1", content: "Support ticket #4421 resolved: webhook timeout fixed by increasing TTL", type: "episodic", importance: 0.7 },
    ];
    for (const m of memData) {
      db.insert(memories).values({ userId, ...m, namespace: "default", createdAt: now - Math.random() * 86400000 * 3 }).run();
    }

    // Demo flow: BRO3 + Agent O
    db.insert(flows).values({ userId, name: "BRO3 + Agent O", description: "BRO3 and Agent O working group", agentIds: JSON.stringify([a1.id, aO.id]), positions: JSON.stringify({}), createdAt: now - 3600000 }).run();

    // Demo rooms
    const room1 = db.insert(rooms).values({ userId, name: "Room 1", description: "Main deliberation space", status: "active", agentIds: JSON.stringify([a1.id, a2.id]), createdAt: now - 3600000 }).returning().get();
    db.insert(rooms).values({ userId, name: "BRO3 + Agent O Council", description: "Deliberation room for BRO3 and Agent O", status: "standby", agentIds: JSON.stringify([a1.id, aO.id]), createdAt: now - 7200000 }).returning().get();
    db.insert(rooms).values({ userId, name: "Room 3", description: "Review & approval space", status: "idle", agentIds: JSON.stringify([a2.id, a3.id]), createdAt: now - 86400000 }).returning().get();

    // Demo messages for room1
    const msgs = [
      { agentId: a1.id, agentName: "Agent 1", agentColor: "#D4AF37", content: "Based on recent memory data — users consistently request faster checkout. Top complaint: too many steps.", isDecision: 0 },
      { agentId: a2.id, agentName: "Agent 2", agentColor: "#3B82F6", content: "Analytics confirm: checkout abandonment is 34% on step 3. Simplifying to 2 steps could recover ~$12K/month.", isDecision: 0 },
      { agentId: a1.id, agentName: "Agent 1", agentColor: "#D4AF37", content: "Agreed. Mobile users drop off 2x more than desktop. Recommend mobile-first redesign.", isDecision: 0 },
      { agentId: a2.id, agentName: "Agent 2", agentColor: "#3B82F6", content: "Consensus reached: prioritize 2-step checkout with mobile-first design for Q2 Sprint 1.", isDecision: 1 },
    ];
    for (const msg of msgs) {
      db.insert(roomMessages).values({ roomId: room1.id, ...msg, createdAt: now - (msgs.indexOf(msg) + 1) * 300000 }).run();
    }

    // Demo logs
    const logData = [
      { agentName: "Agent 1", agentColor: "#D4AF37", operation: "stored", detail: "\"User prefers dark mode and compact layout\"", latencyMs: 38 },
      { agentName: "Agent 2", agentColor: "#3B82F6", operation: "search", detail: "\"Q4 revenue projections\" → 3 results", latencyMs: 45 },
      { agentName: "Agent 1", agentColor: "#D4AF37", operation: "retrieved", detail: "3 memories matched (43ms)", latencyMs: 43 },
      { agentName: "Agent 3", agentColor: "#A855F7", operation: "deliberation", detail: "Room 1 — consensus reached", latencyMs: 0 },
      { agentName: "Agent 2", agentColor: "#3B82F6", operation: "stored", detail: "\"Q2 revenue shows 23% growth in enterprise\"", latencyMs: 41 },
      { agentName: "Agent 1", agentColor: "#D4AF37", operation: "search", detail: "\"checkout abandonment\" → 5 results", latencyMs: 52 },
    ];
    for (let i = 0; i < logData.length; i++) {
      db.insert(logs).values({ userId, ...logData[i], createdAt: now - i * 120000 }).run();
    }
  }
}

export const storage = new Storage();
