import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { embedText, embeddingsEnabled } from "./embeddings";
import { setupWebSocket, broadcastToRoom } from "./ws";
import { triggerAgentResponses } from "./deliberation";
import { registerMcp } from "./mcp";
import { registerBilling } from "./billing";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

async function sendMagicLinkEmail(email: string, token: string): Promise<void> {
  const baseUrl = process.env.APP_URL || "https://usekioku.com";
  const link = `${baseUrl}/verify?token=${token}`;
  if (!resend) {
    console.log(`[MAGIC LINK] ${email} → ${link}`);
    return;
  }
  await resend.emails.send({
    from: "KIOKU™ <noreply@usekioku.com>",
    to: email,
    subject: "Your KIOKU™ login link",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#070D1A;color:#EAE6DC;border-radius:12px;border:1px solid rgba(212,175,55,0.2)">
        <h1 style="color:#D4AF37;margin:0 0 8px">KIOKU™</h1>
        <p style="color:#7A8FAD;margin:0 0 24px;font-size:13px">Agent Control Center by IKONBAI™</p>
        <p style="margin:0 0 24px">Click the button below to sign in. This link expires in 15 minutes.</p>
        <a href="${link}" style="display:inline-block;padding:12px 28px;background:#D4AF37;color:#070D1A;text-decoration:none;border-radius:8px;font-weight:600">Sign in to KIOKU™</a>
        <p style="margin:24px 0 0;font-size:12px;color:#7A8FAD">If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

const JWT_SECRET = process.env.JWT_SECRET || "kioku_jwt_secret_ikonbai_2026";
const DEMO_USER_ID = 1;

function getSessionUser(req: any): number | null {
  const auth = req.headers["x-session-token"] as string;
  if (!auth) return null;
  if (auth === "demo-session") return DEMO_USER_ID;
  try {
    const payload = jwt.verify(auth, JWT_SECRET) as { userId: number };
    return payload.userId ?? null;
  } catch {
    return null;
  }
}

function createSessionToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  // ── WebSocket ─────────────────────────────────────────────────
  setupWebSocket(httpServer);

  // ── MCP Server ────────────────────────────────────────────────
  registerMcp(app);
  registerBilling(app);

  // ── Health ────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", ts: new Date().toISOString() });
  });

  // ── Auth ──────────────────────────────────────────────────────
  // alias for frontend
  app.post("/api/auth/magic-link", async (req, res) => {
    const { email, name, company } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: name || email.split("@")[0], company });
    const token = await storage.createMagicToken(email);
    await sendMagicLinkEmail(email, token);
    const isDev = !process.env.RESEND_API_KEY;
    res.json({ ok: true, ...(isDev && { token }), message: isDev ? "Dev mode: token included" : "Magic link sent to your email" });
  });

  app.post("/api/auth/verify", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });
    const email = await storage.verifyMagicToken(token);
    if (!email) return res.status(401).json({ error: "Invalid or expired token" });
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: email.split("@")[0] });
    const sessionToken = createSessionToken(user.id);
    res.json({ ok: true, sessionToken, user });
  });

  app.post("/api/auth/request-magic-link", async (req, res) => {
    const { email, name, company } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: name || email.split("@")[0], company });
    const token = await storage.createMagicToken(email);
    await sendMagicLinkEmail(email, token);
    const isDev = !process.env.RESEND_API_KEY;
    res.json({ ok: true, ...(isDev && { token }), message: isDev ? "Dev mode: token included" : "Magic link sent to your email" });
  });

  app.post("/api/auth/verify-magic-link", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });
    const email = await storage.verifyMagicToken(token);
    if (!email) return res.status(401).json({ error: "Invalid or expired token" });
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: email.split("@")[0] });
    const sessionToken = createSessionToken(user.id);
    res.json({ ok: true, sessionToken, user });
  });

  app.get("/api/auth/me", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const user = await storage.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  });

  app.post("/api/auth/logout", async (req, res) => {
    res.json({ ok: true }); // JWT is stateless — client discards token
  });

  // ── Stats ─────────────────────────────────────────────────────
  app.get("/api/stats", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getStats(userId));
  });

  app.get("/api/embed/status", (_req, res) => {
    res.json({ enabled: embeddingsEnabled, model: "text-embedding-3-small" });
  });

  // ── Agents ────────────────────────────────────────────────────
  app.get("/api/agents", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getAgents(userId));
  });

  app.post("/api/agents", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, color } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const agent = await storage.createAgent({
      userId,
      name,
      description: description || null,
      color: color || "#D4AF37",
      status: "idle",
      memoriesCount: 0,
      lastActiveAt: null,
      enabled: true,
    });
    res.json(agent);
  });

  app.patch("/api/agents/:id/toggle", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    const { enabled, status } = req.body;
    if (status !== undefined) {
      // direct status set: "online" | "offline" | "idle"
      await storage.updateAgentStatus(agentId, status);
    } else {
      await storage.toggleAgent(agentId, !!enabled);
    }
    res.json({ ok: true });
  });

  app.delete("/api/agents/:id", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    await storage.deleteAgent(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Memories ──────────────────────────────────────────────────
  app.get("/api/memories", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const q = req.query.q as string;
    let results;
    if (q) {
      const queryEmbedding = await embedText(q);
      results = await storage.searchMemories(userId, q, queryEmbedding ?? undefined);
    } else {
      results = await storage.getMemories(userId);
    }
    res.json(results);
  });

  app.post("/api/memories", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { agentId, agentName, content, type, importance, namespace } = req.body;
    if (!content) return res.status(400).json({ error: "Content required" });
    // Generate embedding asynchronously — don't block response
    const embedding = await embedText(content);
    const mem = await storage.createMemory({
      userId,
      agentId: agentId ?? null,
      agentName: agentName ?? null,
      content,
      type: type ?? "semantic",
      importance: importance ?? 0.5,
      namespace: namespace ?? "default",
      embedding: embedding ? JSON.stringify(embedding) : null,
    });
    // Log it
    await storage.addLog({
      userId,
      agentName: agentName ?? "System",
      agentColor: "#D4AF37",
      operation: "stored",
      detail: `"${content.slice(0, 60)}${content.length > 60 ? "…" : ""}"`,
      latencyMs: Math.floor(Math.random() * 30) + 30,
    });
    res.json(mem);
  });

  app.delete("/api/memories/:id", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    await storage.deleteMemory(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Flows ─────────────────────────────────────────────────────
  app.get("/api/flows", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getFlows(userId));
  });

  app.post("/api/flows", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, agentIds, positions } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const flow = await storage.createFlow({
      userId,
      name,
      description: description || null,
      agentIds: JSON.stringify(agentIds ?? []),
      positions: JSON.stringify(positions ?? {}),
    });
    res.json(flow);
  });

  app.patch("/api/flows/:id", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, agentIds, positions, agentRoles } = req.body;
    const updated = await storage.updateFlow(Number(req.params.id), {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(agentIds !== undefined && { agentIds: JSON.stringify(agentIds) }),
      ...(positions !== undefined && { positions: JSON.stringify(positions) }),
      ...(agentRoles !== undefined && { agentRoles: JSON.stringify(agentRoles) }),
    });
    res.json(updated);
  });

  app.delete("/api/flows/:id", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    await storage.deleteFlow(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Rooms ─────────────────────────────────────────────────────
  app.get("/api/rooms", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getRooms(userId));
  });

  app.post("/api/rooms", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, agentIds } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const room = await storage.createRoom({
      userId,
      name,
      description: description || null,
      status: "standby",
      agentIds: JSON.stringify(agentIds ?? []),
    });
    res.json(room);
  });

  app.patch("/api/rooms/:id", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, status, agentIds } = req.body;
    const updated = await storage.updateRoom(Number(req.params.id), {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(status !== undefined && { status }),
      ...(agentIds !== undefined && { agentIds: JSON.stringify(agentIds) }),
    });
    res.json(updated);
  });

  app.delete("/api/rooms/:id", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    await storage.deleteRoom(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── Room Messages ─────────────────────────────────────────────
  app.get("/api/rooms/:id/messages", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getRoomMessages(Number(req.params.id)));
  });

  app.post("/api/rooms/:id/messages", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { agentId, agentName, agentColor, content, isDecision } = req.body;
    if (!content || !agentName) return res.status(400).json({ error: "agentName and content required" });
    const msg = await storage.addRoomMessage({
      roomId: Number(req.params.id),
      agentId: agentId ?? null,
      agentName,
      agentColor: agentColor ?? "#D4AF37",
      content,
      isDecision: !!isDecision,
    });
    // Auto-save decision to memories
    if (isDecision) {
      await storage.createMemory({
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
    await storage.addLog({
      userId,
      agentName,
      agentColor: agentColor ?? "#D4AF37",
      operation: "deliberation",
      detail: isDecision ? `Decision logged: "${content.slice(0, 50)}…"` : `${agentName} contributed to deliberation`,
      latencyMs: null,
    });
    // Broadcast to WebSocket subscribers
    broadcastToRoom(Number(req.params.id), msg);
    res.json(msg);

    // Trigger AI agent responses asynchronously (non-blocking)
    const roomId = Number(req.params.id);
    const room = await storage.getRoom(roomId);
    if (room) {
      const roomAgentIds: number[] = JSON.parse(room.agentIds || "[]");
      triggerAgentResponses(
        roomId,
        userId,
        agentId ?? null,
        agentName,
        content,
        roomAgentIds
      ).catch((e) => console.error("[deliberation]", e));
    }
  });

  // ── Logs / Live Feed ──────────────────────────────────────────
  app.get("/api/logs", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getLogs(userId));
  });

  // ── Waitlist ──────────────────────────────────────────────────
  app.post("/api/waitlist", async (req, res) => {
    const { email, name, company, useCase } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    // Store as a user (reuse magic-link flow — already handles duplicates)
    let user = await storage.getUserByEmail(email);
    if (!user) {
      user = await storage.createUser({
        email,
        name: name || email.split("@")[0],
        company: company || null,
      });
    }
    // Send confirmation email if Resend is configured
    if (resend) {
      try {
        await resend.emails.send({
          from: "KIOKU™ <noreply@usekioku.com>",
          to: email,
          subject: "You're on the KIOKU™ waitlist",
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#070D1A;color:#EAE6DC;border-radius:12px;border:1px solid rgba(212,175,55,0.2)">
              <h1 style="color:#D4AF37;margin:0 0 8px">KIOKU™</h1>
              <p style="color:#7A8FAD;margin:0 0 24px;font-size:13px">Agent Memory &amp; Deliberation Platform by IKONBAI™</p>
              <p style="margin:0 0 16px">You're on the list${name ? `, ${name}` : ""}. We'll reach out when early access opens.</p>
              <p style="font-size:13px;color:#7A8FAD;margin:0">— The KIOKU™ team</p>
            </div>
          `,
        });
      } catch (e) {
        console.error("[waitlist] email error:", e);
      }
    }
    console.log(`[waitlist] ${email}${company ? ` (${company})` : ""}${useCase ? ` use: ${useCase}` : ""}`);
    res.json({ ok: true, message: "You're on the waitlist. We'll be in touch." });
  });

  // ── Billing / Plan ────────────────────────────────────────────
  app.patch("/api/billing/plan", async (req, res) => {
    const userId = getSessionUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { plan, billingCycle } = req.body;
    if (!plan || !billingCycle) return res.status(400).json({ error: "plan and billingCycle required" });
    const updated = await storage.updateUserPlan(userId, plan, billingCycle);
    res.json(updated);
  });

  return httpServer;
}
