import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";

// Simple session map (in-memory, keyed by session token)
const sessions = new Map<string, number>(); // token -> userId

const DEMO_USER_ID = 1; // seed user id

function getSessionUser(req: any): number | null {
  const auth = req.headers["x-session-token"] as string;
  if (!auth) return null;
  if (auth === "demo-session") return DEMO_USER_ID;
  return sessions.get(auth) ?? null;
}

function createSessionToken(userId: number): string {
  const token = "sess_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessions.set(token, userId);
  return token;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  // ── Auth ──────────────────────────────────────────────────────
  // alias for frontend
  app.post("/api/auth/magic-link", (req, res) => {
    const { email, name, company } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    let user = storage.getUserByEmail(email);
    if (!user) user = storage.createUser({ email, name: name || email.split("@")[0], company });
    const token = storage.createMagicToken(email);
    res.json({ ok: true, token, message: "Magic link sent (demo: token included)" });
  });

  app.post("/api/auth/verify", (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });
    const email = storage.verifyMagicToken(token);
    if (!email) return res.status(401).json({ error: "Invalid or expired token" });
    let user = storage.getUserByEmail(email);
    if (!user) user = storage.createUser({ email, name: email.split("@")[0] });
    const sessionToken = createSessionToken(user.id);
    res.json({ ok: true, sessionToken, user });
  });

  app.post("/api/auth/request-magic-link", (req, res) => {
    const { email, name, company } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    // Ensure user exists
    let user = storage.getUserByEmail(email);
    if (!user) {
      user = storage.createUser({ email, name: name || email.split("@")[0], company });
    }
    const token = storage.createMagicToken(email);
    // In production: send via Resend. Here: return token directly for demo
    res.json({ ok: true, token, message: "Magic link sent (demo: token included)" });
  });

  app.post("/api/auth/verify-magic-link", (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });
    const email = storage.verifyMagicToken(token);
    if (!email) return res.status(401).json({ error: "Invalid or expired token" });
    let user = storage.getUserByEmail(email);
    if (!user) user = storage.createUser({ email, name: email.split("@")[0] });
    const sessionToken = createSessionToken(user.id);
    res.json({ ok: true, sessionToken, user });
  });

  app.get("/api/auth/me", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const user = storage.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  });

  app.post("/api/auth/logout", (req, res) => {
    const auth = req.headers["x-session-token"] as string;
    if (auth) sessions.delete(auth);
    res.json({ ok: true });
  });

  // ── Stats ─────────────────────────────────────────────────────
  app.get("/api/stats", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(storage.getStats(userId));
  });

  // ── Agents ────────────────────────────────────────────────────
  app.get("/api/agents", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(storage.getAgents(userId));
  });

  app.post("/api/agents", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, color } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const agent = storage.createAgent({
      userId,
      name,
      description: description || null,
      color: color || "#D4AF37",
      status: "idle",
      memoriesCount: 0,
      lastActiveAt: null,
      enabled: 1,
    });
    res.json(agent);
  });

  app.patch("/api/agents/:id/toggle", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    const { enabled, status } = req.body;
    if (status !== undefined) {
      // direct status set: "online" | "offline" | "idle"
      storage.updateAgentStatus(agentId, status);
    } else {
      storage.toggleAgent(agentId, !!enabled);
    }
    res.json({ ok: true });
  });

  app.delete("/api/agents/:id", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    storage.deleteAgent(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Memories ──────────────────────────────────────────────────
  app.get("/api/memories", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const q = req.query.q as string;
    const results = q ? storage.searchMemories(userId, q) : storage.getMemories(userId);
    res.json(results);
  });

  app.post("/api/memories", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { agentId, agentName, content, type, importance, namespace } = req.body;
    if (!content) return res.status(400).json({ error: "Content required" });
    const mem = storage.createMemory({
      userId,
      agentId: agentId ?? null,
      agentName: agentName ?? null,
      content,
      type: type ?? "semantic",
      importance: importance ?? 0.5,
      namespace: namespace ?? "default",
    });
    // Log it
    storage.addLog({
      userId,
      agentName: agentName ?? "System",
      agentColor: "#D4AF37",
      operation: "stored",
      detail: `"${content.slice(0, 60)}${content.length > 60 ? "…" : ""}"`,
      latencyMs: Math.floor(Math.random() * 30) + 30,
    });
    res.json(mem);
  });

  app.delete("/api/memories/:id", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    storage.deleteMemory(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Flows ─────────────────────────────────────────────────────
  app.get("/api/flows", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(storage.getFlows(userId));
  });

  app.post("/api/flows", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, agentIds, positions } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const flow = storage.createFlow({
      userId,
      name,
      description: description || null,
      agentIds: JSON.stringify(agentIds ?? []),
      positions: JSON.stringify(positions ?? {}),
    });
    res.json(flow);
  });

  app.patch("/api/flows/:id", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, agentIds, positions, agentRoles } = req.body;
    const updated = storage.updateFlow(Number(req.params.id), {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(agentIds !== undefined && { agentIds: JSON.stringify(agentIds) }),
      ...(positions !== undefined && { positions: JSON.stringify(positions) }),
      ...(agentRoles !== undefined && { agentRoles: JSON.stringify(agentRoles) }),
    });
    res.json(updated);
  });

  app.delete("/api/flows/:id", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    storage.deleteFlow(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Rooms ─────────────────────────────────────────────────────
  app.get("/api/rooms", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(storage.getRooms(userId));
  });

  app.post("/api/rooms", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, agentIds } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const room = storage.createRoom({
      userId,
      name,
      description: description || null,
      status: "standby",
      agentIds: JSON.stringify(agentIds ?? []),
    });
    res.json(room);
  });

  app.patch("/api/rooms/:id", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, status, agentIds } = req.body;
    const updated = storage.updateRoom(Number(req.params.id), {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(status !== undefined && { status }),
      ...(agentIds !== undefined && { agentIds: JSON.stringify(agentIds) }),
    });
    res.json(updated);
  });

  app.delete("/api/rooms/:id", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    storage.deleteRoom(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Room Messages ─────────────────────────────────────────────
  app.get("/api/rooms/:id/messages", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(storage.getRoomMessages(Number(req.params.id)));
  });

  app.post("/api/rooms/:id/messages", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { agentId, agentName, agentColor, content, isDecision } = req.body;
    if (!content || !agentName) return res.status(400).json({ error: "agentName and content required" });
    const msg = storage.addRoomMessage({
      roomId: Number(req.params.id),
      agentId: agentId ?? null,
      agentName,
      agentColor: agentColor ?? "#D4AF37",
      content,
      isDecision: isDecision ? 1 : 0,
    });
    // Auto-save decision to memories
    if (isDecision) {
      storage.createMemory({
        userId,
        agentId: agentId ?? null,
        agentName,
        content: `[Decision] ${content}`,
        type: "procedural",
        importance: 0.95,
        namespace: "decisions",
      });
    }
    // Log it
    storage.addLog({
      userId,
      agentName,
      agentColor: agentColor ?? "#D4AF37",
      operation: "deliberation",
      detail: isDecision ? `Decision logged: "${content.slice(0, 50)}…"` : `${agentName} contributed to deliberation`,
      latencyMs: null,
    });
    res.json(msg);
  });

  // ── Logs / Live Feed ──────────────────────────────────────────
  app.get("/api/logs", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(storage.getLogs(userId));
  });

  // ── Billing / Plan ────────────────────────────────────────────
  app.patch("/api/billing/plan", (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { plan, billingCycle } = req.body;
    if (!plan || !billingCycle) return res.status(400).json({ error: "plan and billingCycle required" });
    const updated = storage.updateUserPlan(userId, plan, billingCycle);
    res.json(updated);
  });

  return httpServer;
}
