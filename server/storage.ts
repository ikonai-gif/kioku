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

  private _seedDemoData(userId: number) {
    const now = Date.now();

    // ── Agents ──
    const aBro3    = db.insert(agents).values({ userId, name: "Kote (Boss)",  description: "Founder & CEO — IKONBAI™ Inc.",               color: "#F59E0B", status: "online", memoriesCount: 312, lastActiveAt: now - 30000,   enabled: 1, createdAt: now - 86400000 * 7 }).returning().get();
    const aComp    = db.insert(agents).values({ userId, name: "Computer",     description: "BRO3 — AI execution agent",                   color: "#6366F1", status: "online", memoriesCount: 248, lastActiveAt: now - 15000,   enabled: 1, createdAt: now - 86400000 * 7 }).returning().get();
    const aO       = db.insert(agents).values({ userId, name: "Agent O",      description: "Orchestrator — coordinates all agents",        color: "#10B981", status: "online", memoriesCount: 156, lastActiveAt: now - 60000,   enabled: 1, createdAt: now - 86400000 * 7 }).returning().get();
    const aAnalyst = db.insert(agents).values({ userId, name: "Analyst",      description: "Data & market intelligence",                   color: "#3B82F6", status: "online", memoriesCount: 89,  lastActiveAt: now - 480000,  enabled: 1, createdAt: now - 86400000 }).returning().get();
    const aWriter  = db.insert(agents).values({ userId, name: "Writer",       description: "Content, copy & brand voice",                  color: "#A855F7", status: "idle",   memoriesCount: 34,  lastActiveAt: now - 3600000, enabled: 1, createdAt: now - 86400000 }).returning().get();

    // ── Memories ──
    const memData = [
      { agentId: aBro3.id,    agentName: "Kote (Boss)",  content: "Priority: ship KIOKU™ landing + dashboard to production this week",                    type: "procedural", importance: 0.99 },
      { agentId: aComp.id,    agentName: "Computer",     content: "AUDN Cycle is the core patent-pending differentiator — never compromise it",           type: "semantic",   importance: 0.98 },
      { agentId: aO.id,       agentName: "Agent O",      content: "Orchestration rule: always validate agent consensus before committing memory writes",    type: "procedural", importance: 0.95 },
      { agentId: aAnalyst.id, agentName: "Analyst",      content: "Market window: 3-6 months before Mem0/Zep entrench. Move fast.",                        type: "semantic",   importance: 0.92 },
      { agentId: aComp.id,    agentName: "Computer",     content: "User (Kote) prefers: minimal text output, action over words, no filler phrases",         type: "procedural", importance: 0.97 },
      { agentId: aWriter.id,  agentName: "Writer",       content: "Brand voice: IKONBAI™ Inc. — professional, bold, patent pending on all materials",       type: "procedural", importance: 0.9  },
      { agentId: aAnalyst.id, agentName: "Analyst",      content: "Target markets: USA, Europe, Latin America, Asia — explicitly NOT CIS/SNG",              type: "semantic",   importance: 0.88 },
      { agentId: aO.id,       agentName: "Agent O",      content: "War Room session #1 concluded: deploy landing + fix logo + add light mode — DONE",       type: "episodic",   importance: 0.85 },
    ];
    for (const m of memData) {
      db.insert(memories).values({ userId, ...m, namespace: "default", createdAt: now - Math.random() * 86400000 * 3 }).run();
    }

    // ── Flows ──
    db.insert(flows).values({ userId, name: "BRO3 + Agent O", description: "Core execution pipeline: Computer builds, Agent O orchestrates", agentIds: JSON.stringify([aComp.id, aO.id]), positions: JSON.stringify({}), createdAt: now - 3600000 }).run();
    db.insert(flows).values({ userId, name: "Full Team",       description: "All agents in production mode",                               agentIds: JSON.stringify([aBro3.id, aComp.id, aO.id, aAnalyst.id, aWriter.id]), positions: JSON.stringify({}), createdAt: now - 7200000 }).run();

    // ── Rooms ──
    // War Room — main 3-way meeting
    const warRoom = db.insert(rooms).values({
      userId,
      name: "War Room — Kote × Agent O × Computer",
      description: "Strategic command room. Founder + Orchestrator + Execution. All major decisions here.",
      status: "active",
      agentIds: JSON.stringify([aBro3.id, aO.id, aComp.id]),
      createdAt: now - 3600000
    }).returning().get();

    const analysisRoom = db.insert(rooms).values({
      userId,
      name: "Research & Analysis",
      description: "Market intelligence and competitive analysis",
      status: "standby",
      agentIds: JSON.stringify([aO.id, aAnalyst.id, aWriter.id]),
      createdAt: now - 7200000
    }).returning().get();

    db.insert(rooms).values({
      userId,
      name: "Content Review",
      description: "Brand copy, landing page text, docs review",
      status: "idle",
      agentIds: JSON.stringify([aWriter.id, aComp.id]),
      createdAt: now - 86400000
    }).run();

    // ── War Room messages — real strategy session ──
    const warMsgs = [
      { agentId: aBro3.id,  agentName: "Kote (Boss)",  agentColor: "#F59E0B", content: "Opening session. Agenda: 1) landing page status, 2) dashboard login fix, 3) this week\'s deploy targets. Go.", isDecision: 0 },
      { agentId: aO.id,     agentName: "Agent O",      agentColor: "#10B981", content: "Acknowledged. Routing to Computer for status report on all active builds.", isDecision: 0 },
      { agentId: aComp.id,  agentName: "Computer",     agentColor: "#6366F1", content: "Status: landing page live on usekioku.com \u2714 Light/dark toggle added \u2714 Real logo (555.jpg) in navbar \u2714 Quick Demo login working \u2714 Agent O seeded in dashboard \u2714", isDecision: 0 },
      { agentId: aBro3.id,  agentName: "Kote (Boss)",  agentColor: "#F59E0B", content: "Good. Next: I want this War Room to be the default view when I open the dashboard. Make it feel like a real command center.", isDecision: 0 },
      { agentId: aO.id,     agentName: "Agent O",      agentColor: "#10B981", content: "Understood. Flagging for Computer: War Room should open first on dashboard load. Also recommend pinning active session to sidebar.", isDecision: 0 },
      { agentId: aComp.id,  agentName: "Computer",     agentColor: "#6366F1", content: "On it. Will also add message timestamps, participant status badges, and a \"consensus\" commit button for decisions.", isDecision: 0 },
      { agentId: aBro3.id,  agentName: "Kote (Boss)",  agentColor: "#F59E0B", content: "Perfect. Deploy target: usekioku.com + Vercel by end of session. IKONBAI\u2122 brand everywhere. Patent Pending on all pages.", isDecision: 0 },
      { agentId: aO.id,     agentName: "Agent O",      agentColor: "#10B981", content: "\u2705 CONSENSUS REACHED: Deploy landing + dashboard this week. War Room = default entry point. IKONBAI\u2122 Inc. branding on all surfaces.", isDecision: 1 },
    ];
    for (let i = 0; i < warMsgs.length; i++) {
      db.insert(roomMessages).values({ roomId: warRoom.id, ...warMsgs[i], createdAt: now - (warMsgs.length - i) * 240000 }).run();
    }

    // Analysis room messages
    const analysisMsgs = [
      { agentId: aO.id,       agentName: "Agent O",  agentColor: "#10B981", content: "Task: competitive analysis vs Mem0 and Zep AI. Focus on positioning gaps.", isDecision: 0 },
      { agentId: aAnalyst.id, agentName: "Analyst",  agentColor: "#3B82F6", content: "Mem0: YC-backed, $5M, strong Python community. Weakness: no multi-agent deliberation, no AUDN. Zep: enterprise focus, heavier infra. KIOKU\u2122 wins on: deliberation rooms + AUDN cycle + simplicity.", isDecision: 0 },
      { agentId: aWriter.id,  agentName: "Writer",   agentColor: "#A855F7", content: "Recommended tagline update: \"The only memory layer that thinks before it writes.\" Leans into AUDN differentiator directly.", isDecision: 0 },
      { agentId: aO.id,       agentName: "Agent O",  agentColor: "#10B981", content: "\u2705 Decision: use AUDN as primary differentiator in all GTM. Tagline approved for next landing iteration.", isDecision: 1 },
    ];
    for (let i = 0; i < analysisMsgs.length; i++) {
      db.insert(roomMessages).values({ roomId: analysisRoom.id, ...analysisMsgs[i], createdAt: now - (analysisMsgs.length - i) * 600000 }).run();
    }

    // ── Logs ──
    const logData = [
      { agentName: "Computer",    agentColor: "#6366F1", operation: "stored",       detail: "\"Kote prefers minimal text, action over words\" — AUDN: Add",         latencyMs: 38 },
      { agentName: "Agent O",     agentColor: "#10B981", operation: "deliberation", detail: "War Room — consensus reached on deploy targets",                      latencyMs: 0  },
      { agentName: "Analyst",     agentColor: "#3B82F6", operation: "search",       detail: "\"Mem0 vs Zep vs KIOKU\" → 12 results",                               latencyMs: 45 },
      { agentName: "Computer",    agentColor: "#6366F1", operation: "stored",       detail: "\"Landing deployed to usekioku.com\" — AUDN: Add",                     latencyMs: 41 },
      { agentName: "Agent O",     agentColor: "#10B981", operation: "retrieved",    detail: "5 memories matched for War Room context (31ms)",                       latencyMs: 31 },
      { agentName: "Writer",      agentColor: "#A855F7", operation: "stored",       detail: "\"Tagline: the only memory layer that thinks before it writes\" — AUDN: Add", latencyMs: 44 },
      { agentName: "Kote (Boss)", agentColor: "#F59E0B", operation: "stored",       detail: "\"Deploy target: Vercel + Railway by end of week\" — AUDN: Add",      latencyMs: 29 },
      { agentName: "Computer",    agentColor: "#6366F1", operation: "search",       detail: "\"light mode toggle usekioku\" → 3 results",                          latencyMs: 52 },
    ];
    for (let i = 0; i < logData.length; i++) {
      db.insert(logs).values({ userId, ...logData[i], createdAt: now - i * 120000 }).run();
    }
  }
}

export const storage = new Storage();

// ── Bootstrap demo user on startup ──
// Ensures demo-session token (userId=1) always has data
(function initDemoUser() {
  const existing = storage.getUserByEmail("demo@kioku.ai");
  if (!existing) {
    storage.createUser({ email: "demo@kioku.ai", name: "Kote (Demo)", company: "IKONBAI™ Inc.", plan: "pro" });
    console.log("[KIOKU] Demo user seeded");
  }
})();
