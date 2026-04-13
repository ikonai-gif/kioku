import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import jwt from "jsonwebtoken";
import { embedText, embeddingsEnabled } from "./embeddings";
import { setupWebSocket, broadcastToRoom } from "./ws";
import { triggerAgentResponses } from "./deliberation";
import { runDeliberation, getSession, getSessionsByRoom, getLatestConsensus } from "./structured-deliberation";
import { registerMcp } from "./mcp";
import { randomBytes } from "crypto";
import { registerBilling } from "./billing";
import { recordAuthFailure, recordAuthSuccess } from "./auth-hooks";
import { checkRegistrationLimit } from "./ratelimit";
import {
  validateBody, ValidationError,
  magicLinkSchema, verifyTokenSchema,
  createAgentSchema, updateAgentSchema, toggleAgentSchema,
  createMemorySchema, purgeMemoriesSchema,
  createFlowSchema, updateFlowSchema,
  createRoomSchema, updateRoomSchema,
  createRoomMessageSchema, deliberateSchema,
  createWebhookSchema, createAgentTokenSchema, agentCallbackSchema,
  warRoomMessageSchema, updatePlanSchema, registerSchema, waitlistSchema,
} from "./validation";

const BREVO_API_KEY = process.env.BREVO_API_KEY || null;

const SENDERS = {
  support: { name: "KIOKU™ Support",  email: "support@usekioku.com" },
  kote:    { name: "Kote — KIOKU™",   email: "kote@usekioku.com" },
  legal:   { name: "KIOKU™ Legal",    email: "legal@usekioku.com" },
};

async function sendBrevoEmail(to: string, subject: string, html: string, sender: keyof typeof SENDERS = "support"): Promise<void> {
  if (!BREVO_API_KEY) return;
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      sender: SENDERS[sender],
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[Brevo] ${res.status}: ${err}`);
  }
}

async function sendMagicLinkEmail(email: string, token: string): Promise<void> {
  const baseUrl = process.env.APP_URL || "https://usekioku.com";
  const link = `${baseUrl}/verify?token=${token}`;
  if (!BREVO_API_KEY) {
    console.log(`[MAGIC LINK] ${email} → ${link}`);
    return;
  }
  await sendBrevoEmail(
    email,
    "Your KIOKU™ login link",
    `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#070D1A;color:#EAE6DC;border-radius:12px;border:1px solid rgba(212,175,55,0.2)">
      <h1 style="color:#D4AF37;margin:0 0 8px">KIOKU™</h1>
      <p style="color:#7A8FAD;margin:0 0 24px;font-size:13px">Agent Control Center by IKONBAI™</p>
      <p style="margin:0 0 24px">Click the button below to sign in. This link expires in 15 minutes.</p>
      <a href="${link}" style="display:inline-block;padding:12px 28px;background:#D4AF37;color:#070D1A;text-decoration:none;border-radius:8px;font-weight:600">Sign in to KIOKU™</a>
      <p style="margin:24px 0 0;font-size:12px;color:#7A8FAD">If you didn't request this, ignore this email.</p>
    </div>`
  );
}

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret');

const COOKIE_NAME = "kioku_session";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  path: "/",
};

function getSessionUser(req: any): number | null {
  // 1. x-session-token header (legacy + API clients)
  const headerAuth = req.headers["x-session-token"] as string;
  if (headerAuth) {
    try {
      const payload = jwt.verify(headerAuth, JWT_SECRET) as { userId: number };
      return payload.userId ?? null;
    } catch { /* fall through to cookie */ }
  }
  // 2. httpOnly cookie (browser sessions — survives page refresh)
  const cookieToken = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (!cookieToken) return null;
  try {
    const payload = jwt.verify(cookieToken, JWT_SECRET) as { userId: number };
    return payload.userId ?? null;
  } catch {
    return null;
  }
}

function createSessionToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

// API key auth — for external agents (Boss Agent, IKONBAI™ v2, etc.)
// Accepts: Authorization: Bearer kk_<key> OR x-api-key: kk_<key>
async function getApiKeyUser(req: any): Promise<number | null> {
  // Try x-api-key header first (primary for external clients)
  const xApiKey = (req.headers["x-api-key"] as string) || "";
  if (xApiKey.startsWith("kk_")) {
    try {
      const user = await storage.getUserByApiKey(xApiKey);
      return user ? user.id : null;
    } catch { return null; }
  }
  // Fallback: Authorization: Bearer kk_<key>
  const auth = (req.headers["authorization"] as string) || "";
  if (!auth.startsWith("Bearer kk_")) return null;
  const key = auth.replace("Bearer ", "").trim();
  try {
    const user = await storage.getUserByApiKey(key);
    return user ? user.id : null;
  } catch {
    return null;
  }
}

// Unified auth — session token OR API key OR master key
async function getUser(req: any): Promise<number | null> {
  const sessionUser = getSessionUser(req);
  if (sessionUser !== null) return sessionUser;
  // Master key grants admin access (user 1)
  const masterKey = process.env.KIOKU_MASTER_KEY;
  if (masterKey) {
    const xApiKey = (req.headers["x-api-key"] as string) || "";
    const xMasterKey = (req.headers["x-master-key"] as string) || "";
    if (xApiKey === masterKey || xMasterKey === masterKey) return 1;
  }
  return getApiKeyUser(req);
}

// Agent token auth — for external agents (kat_* tokens)
async function getAgentAuth(req: any): Promise<{ agentId: number; userId: number; scopes: string[] } | null> {
  const token = (req.headers["x-agent-token"] as string) || "";
  if (!token.startsWith("kat_")) return null;
  return storage.validateAgentToken(token);
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
    const { email, name, company } = validateBody(magicLinkSchema, req.body);
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: name || email.split("@")[0], company });
    const token = await storage.createMagicToken(email);
    await sendMagicLinkEmail(email, token);
    const isDev = !process.env.BREVO_API_KEY;
    res.json({ ok: true, ...(isDev && { token }), message: isDev ? "Dev mode: token included" : "Magic link sent to your email" });
  });

  app.post("/api/auth/verify", async (req, res) => {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const { token } = validateBody(verifyTokenSchema, req.body);
    const email = await storage.verifyMagicToken(token);
    if (!email) {
      recordAuthFailure(ip);
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: email.split("@")[0] });
    const sessionToken = createSessionToken(user.id);
    recordAuthSuccess(ip);
    res.json({ ok: true, sessionToken, user });
  });

  app.post("/api/auth/request-magic-link", async (req, res) => {
    const { email, name, company } = validateBody(magicLinkSchema, req.body);
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: name || email.split("@")[0], company });
    const token = await storage.createMagicToken(email);
    await sendMagicLinkEmail(email, token);
    const isDev = !process.env.BREVO_API_KEY;
    res.json({ ok: true, ...(isDev && { token }), message: isDev ? "Dev mode: token included" : "Magic link sent to your email" });
  });

  app.post("/api/auth/verify-magic-link", async (req, res) => {
    const { token } = validateBody(verifyTokenSchema, req.body);
    const email = await storage.verifyMagicToken(token);
    if (!email) return res.status(401).json({ error: "Invalid or expired token" });
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: email.split("@")[0] });
    const sessionToken = createSessionToken(user.id);
    // Set httpOnly cookie so session survives page refresh
    res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTS);
    res.json({ ok: true, sessionToken, user });
  });

  app.get("/api/auth/me", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const user = await storage.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  });

  app.post("/api/auth/logout", async (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  });

  // ── Stats ─────────────────────────────────────────────────────
  app.get("/api/stats", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getStats(userId));
  });

  app.get("/api/embed/status", (_req, res) => {
    res.json({ enabled: embeddingsEnabled, model: "text-embedding-3-small" });
  });

  // ── Agents ────────────────────────────────────────────────────
  app.get("/api/agents", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getAgents(userId));
  });

  app.post("/api/agents", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, color } = validateBody(createAgentSchema, req.body);
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

  // Update agent fields (name, description, color, model)
  app.patch("/api/agents/:id", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    const { name, description, color, model, role } = validateBody(updateAgentSchema, req.body);
    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (color !== undefined) updates.color = color;
    if (model !== undefined) updates.model = model;
    if (role !== undefined) updates.role = role;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No fields to update" });
    const ok = await storage.updateAgent(agentId, userId, updates);
    if (!ok) return res.status(404).json({ error: "Not found" });
    const agent = await storage.getAgent(agentId);
    res.json(agent);
  });

  app.patch("/api/agents/:id/toggle", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    const { enabled, status } = validateBody(toggleAgentSchema, req.body);
    let ok: boolean;
    if (status !== undefined) {
      ok = await storage.updateAgentStatus(agentId, userId, status);
    } else {
      ok = await storage.toggleAgent(agentId, userId, !!enabled);
    }
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  app.delete("/api/agents/:id", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteAgent(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });


  // ── Webhooks (external agents) ─────────────────────────────────
  app.post("/api/agents/:id/webhook", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    // Verify agent belongs to user
    const agent = await storage.getAgent(agentId);
    if (!agent || agent.userId !== userId) return res.status(404).json({ error: "Not found" });
    const { url } = validateBody(createWebhookSchema, req.body);
    const secret = "whk_" + randomBytes(24).toString("hex");
    await storage.registerWebhook({ agentId, userId, url, secret });
    res.json({ ok: true, agentId, url, secret, note: "Save this secret — it signs X-Kioku-Signature headers" });
  });

  app.get("/api/agents/:id/webhook", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const wh = await storage.getWebhook(Number(req.params.id), userId);
    if (!wh) return res.status(404).json({ error: "No webhook registered" });
    res.json(wh);
  });

  app.delete("/api/agents/:id/webhook", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteWebhook(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  app.get("/api/webhooks", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const webhooks = await storage.getWebhooksByUser(userId);
    res.json(webhooks);
  });

  // ── Agent Tokens (external agent auth) ─────────────────────────
  app.post("/api/agents/:id/token", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    // Verify agent belongs to user
    const agent = await storage.getAgent(agentId);
    if (!agent || agent.userId !== userId) return res.status(404).json({ error: "Not found" });
    const { name, scopes, expiresInDays } = validateBody(createAgentTokenSchema, req.body || {});
    const result = await storage.createAgentToken({ agentId, userId, name, scopes, expiresInDays });
    res.json({ ok: true, ...result, note: "Save this token — it cannot be retrieved later" });
  });

  app.get("/api/agents/:id/tokens", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const tokens = await storage.getAgentTokens(Number(req.params.id), userId);
    res.json(tokens);
  });

  app.delete("/api/agents/:id/tokens/:tokenId", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const revoked = await storage.revokeAgentToken(Number(req.params.tokenId), userId);
    if (!revoked) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  app.delete("/api/agents/:id/tokens", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    await storage.revokeAllAgentTokens(Number(req.params.id), userId);
    res.json({ ok: true });
  });

  // ── Agent Callback (external agents authenticate with kat_* token) ──
  app.post("/api/agent-callback", async (req, res) => {
    const auth = await getAgentAuth(req);
    if (!auth) return res.status(401).json({ error: "Invalid or expired agent token" });
    if (!auth.scopes.includes("deliberation.respond")) {
      return res.status(403).json({ error: "Token lacks deliberation.respond scope" });
    }
    const { sessionId, position, confidence, reasoning } = validateBody(agentCallbackSchema, req.body);
    // Log the callback
    await storage.addLog({
      userId: auth.userId,
      agentName: `External Agent #${auth.agentId}`,
      agentColor: "#9B59B6",
      operation: "agent_callback",
      detail: `Session ${sessionId}: position received (confidence=${confidence || 0.5})`,
      latencyMs: null,
    });
    res.json({ ok: true, received: { agentId: auth.agentId, sessionId, position, confidence: confidence || 0.5 } });
  });

  // Agent token validation endpoint (for external agents to verify their token)
  app.get("/api/agent-auth/verify", async (req, res) => {
    const auth = await getAgentAuth(req);
    if (!auth) return res.status(401).json({ error: "Invalid or expired agent token" });
    res.json({ ok: true, agentId: auth.agentId, userId: auth.userId, scopes: auth.scopes });
  });
  // ── Memories ──────────────────────────────────────────────────
  app.get("/api/memories", async (req, res) => {
    const userId = await getUser(req);
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
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { agentId, agentName, content, type, importance, namespace } = validateBody(createMemorySchema, req.body);
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
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteMemory(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  // ── GDPR: Purge (Art. 17) ──────────────────────────────────────
  app.delete("/api/memories/purge", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { scope, agent_id } = validateBody(purgeMemoriesSchema, req.body ?? {});
    if (scope === 'agent' && !agent_id) {
      return res.status(400).json({ error: "agent_id required when scope is 'agent'" });
    }
    const deleted = await storage.purgeMemories(userId, scope, agent_id);
    await storage.addLog({
      userId,
      agentName: "System",
      agentColor: "#D4AF37",
      operation: "purge",
      detail: `GDPR purge: scope=${scope}${agent_id ? ` agent_id=${agent_id}` : ''}, deleted=${deleted}`,
      latencyMs: null,
    });
    res.json({ ok: true, deleted });
  });

  // ── GDPR: Export (Art. 20) ──────────────────────────────────────
  app.get("/api/memories/export", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const data = await storage.exportMemories(userId);
    res.setHeader("Content-Disposition", 'attachment; filename="kioku-export.json"');
    res.setHeader("Content-Type", "application/json");
    res.json(data);
  });

  // ── Flows ─────────────────────────────────────────────────────
  app.get("/api/flows", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getFlows(userId));
  });

  app.post("/api/flows", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, agentIds, positions } = validateBody(createFlowSchema, req.body);
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
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, agentIds, positions, agentRoles } = validateBody(updateFlowSchema, req.body);
    const updated = await storage.updateFlow(Number(req.params.id), userId, {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description: description ?? undefined }),
      ...(agentIds !== undefined && { agentIds: JSON.stringify(agentIds) }),
      ...(positions !== undefined && { positions: JSON.stringify(positions) }),
      ...(agentRoles !== undefined && { agentRoles: JSON.stringify(agentRoles) }),
    });
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.delete("/api/flows/:id", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteFlow(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  // ── Rooms ─────────────────────────────────────────────────────
  app.get("/api/rooms", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getRooms(userId));
  });

  app.post("/api/rooms", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, agentIds } = validateBody(createRoomSchema, req.body);
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
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, description, status, agentIds } = validateBody(updateRoomSchema, req.body);
    const updated = await storage.updateRoom(Number(req.params.id), userId, {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description: description ?? undefined }),
      ...(status !== undefined && { status }),
      ...(agentIds !== undefined && { agentIds: JSON.stringify(agentIds) }),
    });
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.delete("/api/rooms/:id", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteRoom(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  // ── Room Messages ─────────────────────────────────────────────
  app.get("/api/rooms/:id/messages", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const messages = await storage.getRoomMessages(Number(req.params.id), userId);
    if (messages === null) return res.status(404).json({ error: "Not found" });
    res.json(messages);
  });

  app.post("/api/rooms/:id/messages", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { agentId, agentName, agentColor, content, isDecision } = validateBody(createRoomMessageSchema, req.body);
    const msg = await storage.addRoomMessage({
      roomId: Number(req.params.id),
      agentId: agentId ?? null,
      agentName,
      agentColor: agentColor ?? "#D4AF37",
      content,
      isDecision: !!isDecision,
    }, userId);
    if (!msg) return res.status(404).json({ error: "Not found" });
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
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getLogs(userId));
  });

  // ── War Room — Agent Write API ──────────────────────────────────────────
  // POST /api/warroom/message — Boss Agent or external agents write to War Room
  // Finds or creates a "War Room" room, posts message, broadcasts via WebSocket
  app.post("/api/warroom/message", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { agentName, content, agentColor, isDecision, roomName } = validateBody(warRoomMessageSchema, req.body);

    // Find or create the target room
    const targetRoomName = roomName || "War Room";
    let allRooms = await storage.getRooms(userId);
    let room = allRooms.find((r: any) => r.name === targetRoomName);
    if (!room) {
      room = await storage.createRoom({
        userId,
        name: targetRoomName,
        description: "Shared agent coordination room",
        status: "active",
        agentIds: "[]",
      });
    }

    const msg = await storage.addRoomMessage({
      roomId: room.id,
      agentId: null,
      agentName,
      agentColor: agentColor ?? "#D4AF37",
      content,
      isDecision: !!isDecision,
    }, userId);
    if (!msg) return res.status(404).json({ error: "Room not found" });

    if (isDecision) {
      await storage.createMemory({
        userId,
        agentId: null,
        agentName,
        content: `[Decision] ${content}`,
        type: "procedural",
        importance: 0.95,
        namespace: "decisions",
      });
    }

    await storage.addLog({
      userId,
      agentName,
      agentColor: agentColor ?? "#D4AF37",
      operation: "warroom",
      detail: `${agentName} posted to ${targetRoomName}: "${content.slice(0, 60)}…"`,
      latencyMs: null,
    });

    broadcastToRoom(room.id, msg);
    res.json({ ok: true, roomId: room.id, message: msg });
  });

  // ── API Key Rotation ──────────────────────────────────────────
  app.post("/api/auth/rotate-key", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (userId === 1) return res.status(403).json({ error: "Demo account key cannot be rotated" });
    const user = await storage.rotateApiKey(userId);
    res.json({ ok: true, apiKey: user?.apiKey });
  });

  // ── Waitlist ──────────────────────────────────────────────────
  app.post("/api/waitlist", async (req, res) => {
    const { email, name, company, useCase } = validateBody(waitlistSchema, req.body);
    // Store as a user (reuse magic-link flow — already handles duplicates)
    let user = await storage.getUserByEmail(email);
    if (!user) {
      user = await storage.createUser({
        email,
        name: name || email.split("@")[0],
        company: company || undefined,
      });
    }
    // Send confirmation email via Brevo
    if (BREVO_API_KEY) {
      try {
        await sendBrevoEmail(
          email,
          "You're on the KIOKU™ waitlist",
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#070D1A;color:#EAE6DC;border-radius:12px;border:1px solid rgba(212,175,55,0.2)">
            <h1 style="color:#D4AF37;margin:0 0 8px">KIOKU™</h1>
            <p style="color:#7A8FAD;margin:0 0 24px;font-size:13px">Agent Memory &amp; Deliberation Platform by IKONBAI™</p>
            <p style="margin:0 0 16px">You're on the list${name ? `, ${name}` : ""}. We'll reach out when early access opens.</p>
            <p style="font-size:13px;color:#7A8FAD;margin:0">— Kote, KIOKU™</p>
          </div>`,
          "kote"
        );
      } catch (e) {
        console.error("[waitlist] email error:", e);
      }
    }
    console.log(`[waitlist] ${email}${company ? ` (${company})` : ""}${useCase ? ` use: ${useCase}` : ""}`);
    res.json({ ok: true, message: "You're on the waitlist. We'll be in touch." });
  });

  // ── Tenant Self-Registration ──────────────────────────────────
  // POST /api/register — create new tenant + generate API key
  // (accessible via /api/v1/register thanks to versioning middleware)
  app.post("/api/register", async (req, res) => {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";

    // Rate limit: 3 registrations per hour per IP
    const { allowed, retryAfter } = checkRegistrationLimit(ip);
    if (!allowed) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Registration rate limit exceeded. Try again later.",
        code: "REGISTRATION_RATE_LIMITED",
        status: 429,
      });
    }

    const { email, name, plan } = validateBody(registerSchema, req.body);

    // Check if user already exists
    const existing = await storage.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({
        error: "An account with this email already exists",
        code: "CONFLICT",
        status: 409,
      });
    }

    const user = await storage.createUser({
      email,
      name: name || email.split("@")[0],
      plan: "dev", // free tier maps to "dev" plan internally
    });

    res.status(201).json({
      api_key: user.apiKey,
      tenant_id: user.id,
      email: user.email,
      plan: "free",
      message: "Registration successful. Use the api_key in the x-api-key header for API access.",
    });
  });

  // ── Usage Dashboard ──────────────────────────────────────────
  // GET /api/usage — returns usage stats for authenticated API key
  // (accessible via /api/v1/usage thanks to versioning middleware)
  app.get("/api/usage", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", status: 401 });

    const user = await storage.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found", code: "NOT_FOUND", status: 404 });

    const [memoriesCount, agentsList, roomsList, stats] = await Promise.all([
      storage.getMemoriesCount(userId),
      storage.getAgents(userId),
      storage.getRooms(userId),
      storage.getStats(userId),
    ]);

    // Get request counts from kioku_request_logs
    const { pool } = await import("./storage");
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const apiKeyPrefix = user.apiKey.slice(0, 12) + "…";

    const [todayResult, monthResult] = await Promise.all([
      pool.query(
        "SELECT COUNT(*) as cnt FROM kioku_request_logs WHERE api_key_id = $1 AND timestamp >= $2",
        [apiKeyPrefix, todayStart.getTime()]
      ),
      pool.query(
        "SELECT COUNT(*) as cnt FROM kioku_request_logs WHERE api_key_id = $1 AND timestamp >= $2",
        [apiKeyPrefix, monthStart.getTime()]
      ),
    ]);

    const PLAN_LIMITS: Record<string, { perMin: number; daily: number }> = {
      dev:        { perMin: 60, daily: 5_000 },
      free:       { perMin: 60, daily: 5_000 },
      starter:    { perMin: 300, daily: 50_000 },
      growth:     { perMin: 1_000, daily: 200_000 },
      pro:        { perMin: 1_000, daily: 200_000 },
      team:       { perMin: 5_000, daily: 1_000_000 },
      business:   { perMin: 5_000, daily: 1_000_000 },
      enterprise: { perMin: 9_999, daily: 99_999_999 },
    };

    const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS["dev"];

    res.json({
      memories_count: memoriesCount,
      rooms_count: roomsList.length,
      agents_count: agentsList.length,
      requests_today: parseInt(todayResult.rows[0]?.cnt ?? "0"),
      requests_this_month: parseInt(monthResult.rows[0]?.cnt ?? "0"),
      plan: user.plan,
      limits: {
        requests_per_minute: limits.perMin,
        requests_per_day: limits.daily,
      },
      stats: {
        total_operations: stats.totalOps,
        avg_latency_ms: stats.avgLatency,
        active_agents: stats.activeAgents,
      },
    });
  });

  // ── Billing / Plan ────────────────────────────────────────────
  app.patch("/api/billing/plan", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { plan, billingCycle } = validateBody(updatePlanSchema, req.body);
    const updated = await storage.updateUserPlan(userId, plan, billingCycle);
    res.json(updated);
  });

  // ── Structured Deliberation (Phase B-1) ───────────────────────

  // Start a structured deliberation session
  app.post("/api/rooms/:id/deliberate", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const roomId = Number(req.params.id);
    // Verify room belongs to user
    const roomCheck = await storage.getRoom(roomId, userId);
    if (!roomCheck) return res.status(404).json({ error: "Not found" });
    const { topic, model, debateRounds } = validateBody(deliberateSchema, req.body);
    try {
      const session = await runDeliberation(roomId, userId, topic, {
        model: model || undefined,
        debateRounds: debateRounds ?? 2,
      });
      res.json(session);
    } catch (err) {
      const message = (err as Error).message;
      const status = message.includes("already running") ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  // Get deliberation session by ID
  app.get("/api/rooms/:id/deliberations/:sessionId", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    // Verify room belongs to user
    const room = await storage.getRoom(Number(req.params.id), userId);
    if (!room) return res.status(404).json({ error: "Not found" });
    const session = await getSession(req.params.sessionId);
    if (!session || session.roomId !== Number(req.params.id)) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json(session);
  });

  // List all deliberation sessions for a room
  app.get("/api/rooms/:id/deliberations", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    // Verify room belongs to user
    const room = await storage.getRoom(Number(req.params.id), userId);
    if (!room) return res.status(404).json({ error: "Not found" });
    const sessions = await getSessionsByRoom(Number(req.params.id));
    res.json(sessions);
  });

  // Get latest consensus for a room
  app.get("/api/rooms/:id/consensus", async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    // Verify room belongs to user
    const room = await storage.getRoom(Number(req.params.id), userId);
    if (!room) return res.status(404).json({ error: "Not found" });
    const consensus = await getLatestConsensus(Number(req.params.id));
    if (!consensus) return res.status(404).json({ error: "No consensus found" });
    res.json(consensus);
  });

  // ── Global error handler ──────────────────────────────────────
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("[unhandled]", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return httpServer;
}
