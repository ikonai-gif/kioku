import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage, pool } from "./storage";
import jwt from "jsonwebtoken";
import logger from "./logger";
import { embedText, embeddingsEnabled } from "./embeddings";
import { setupWebSocket, broadcastToRoom, getActiveWsConnectionCount } from "./ws";
import { triggerAgentResponses } from "./deliberation";
import { runDeliberation, getSession, getSessionsByRoom, getLatestConsensus, submitHumanInput, getActiveDeliberationCount, getProvenanceChain, getProvenanceTree } from "./structured-deliberation";
import { registerMcp } from "./mcp";
import { randomBytes } from "crypto";
import { registerBilling } from "./billing";
import { recordAuthFailure, recordAuthSuccess } from "./auth-hooks";
import { safeCompare } from "./index";
import { checkRegistrationLimit, checkAuthRateLimit } from "./ratelimit";
import { getLimits, AI_QUOTAS, getUsageLimits } from "./limits";
import { consolidateMemories } from "./memory-consolidation";
import { pruneDecayedMemories } from "./memory-gc";
import {
  validateBody, ValidationError,
  magicLinkSchema, verifyTokenSchema,
  createAgentSchema, updateAgentSchema, toggleAgentSchema,
  createMemorySchema, purgeMemoriesSchema,
  createFlowSchema, updateFlowSchema,
  createRoomSchema, updateRoomSchema,
  createRoomMessageSchema, deliberateSchema, humanInputSchema,
  createWebhookSchema, createAgentTokenSchema, agentCallbackSchema,
  agentTurnResponseSchema,
  warRoomMessageSchema, updatePlanSchema, registerSchema, waitlistSchema,
  createMemoryLinkSchema,
} from "./validation";
import { body, validationResult } from "express-validator";

// express-validator middleware: validate → check errors → proceed
function handleValidationErrors(req: Request, res: Response, next: NextFunction) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "Validation failed", details: errors.array() });
  }
  next();
}

// Validation rules for critical endpoints
const validateMemory = [
  body("content").isString().isLength({ min: 1, max: 50000 }).withMessage("content must be 1-50000 chars"),
  body("type").optional().isString().withMessage("type must be a string"),
  body("namespace").optional().isString().isLength({ max: 100 }).withMessage("namespace max 100 chars"),
  body("importance").optional().isFloat({ min: 0, max: 1 }).withMessage("importance must be 0-1"),
  handleValidationErrors,
];

const validateRoom = [
  body("name").isString().isLength({ min: 1, max: 200 }).withMessage("name must be 1-200 chars"),
  body("topic").optional().isString().isLength({ max: 1000 }).withMessage("topic max 1000 chars"),
  handleValidationErrors,
];

const validateAgent = [
  body("name").isString().isLength({ min: 1, max: 100 }).withMessage("name must be 1-100 chars"),
  body("description").optional().isString().isLength({ max: 1000 }).withMessage("description max 1000 chars"),
  body("model").optional().isString().withMessage("model must be a string"),
  handleValidationErrors,
];

const validateMagicLink = [
  body("email").isEmail().withMessage("must be a valid email"),
  handleValidationErrors,
];

// Async error wrapper — catches unhandled promise rejections in route handlers
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function stripEmbedding(mem: any, include: boolean) {
  if (include) return mem;
  const { embedding, ...rest } = mem;
  return rest;
}

/** Mask per-agent API key in responses — only show last 4 chars */
function maskAgentApiKey(agent: any): any {
  if (!agent) return agent;
  if (agent.llmApiKey) {
    const key = agent.llmApiKey;
    agent = { ...agent, llmApiKey: key.length > 4 ? "••••" + key.slice(-4) : "••••" };
  }
  return agent;
}

/** Strip sensitive fields from user objects before sending to client */
function sanitizeUser(user: any): any {
  if (!user) return user;
  const { apiKey, api_key, ...safe } = user;
  // Return masked key so the frontend can show "kk_••••abcd"
  if (apiKey) {
    safe.apiKeyHint = apiKey.length > 8 ? apiKey.slice(0, 3) + "••••" + apiKey.slice(-4) : "••••";
  } else if (api_key) {
    safe.apiKeyHint = api_key.length > 8 ? api_key.slice(0, 3) + "••••" + api_key.slice(-4) : "••••";
  }
  return safe;
}

/** Sanitize user-supplied content to prevent stored XSS */
function sanitizeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Internal namespaces hidden from non-owner users
const INTERNAL_NAMESPACES = ['_system', '_audit', '_internal'];

/** Check if a user has the 'owner' role */
async function isOwner(userId: number): Promise<boolean> {
  const user = await storage.getUserById(userId);
  return user?.role === 'owner';
}

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
  const link = `${baseUrl}/auth/verify/${token}`;
  if (!BREVO_API_KEY) {
    logger.info({ source: "auth", email }, `magic link: ${link}`);
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
      const payload = jwt.verify(headerAuth, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: number };
      return payload.userId ?? null;
    } catch { /* fall through to cookie */ }
  }
  // 2. httpOnly cookie (browser sessions — survives page refresh)
  const cookieToken = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (!cookieToken) return null;
  try {
    const payload = jwt.verify(cookieToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: number };
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
    if (safeCompare(xApiKey, masterKey) || safeCompare(xMasterKey, masterKey)) return 1;
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
  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({
        status: "ok",
        version: "1.0.0",
        uptime: Math.floor(process.uptime()),
        database: "connected",
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(503).json({
        status: "down",
        database: "disconnected",
        error: (err as Error).message
      });
    }
  });

  // ── Auth ──────────────────────────────────────────────────────
  // alias for frontend
  app.post("/api/auth/magic-link", ...validateMagicLink, asyncHandler(async (req, res) => {
    const { email, name, company } = validateBody(magicLinkSchema, req.body);
    if (email && !checkAuthRateLimit(`magic:${email}`, 15, 3600000)) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: name || email.split("@")[0], company });
    const token = await storage.createMagicToken(email);
    await sendMagicLinkEmail(email, token);
    const isDev = !process.env.BREVO_API_KEY;
    res.json({ ok: true, ...(isDev && { token }), message: isDev ? "Dev mode: token included" : "Magic link sent to your email" });
  }));

  app.post("/api/auth/verify", asyncHandler(async (req, res) => {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    if (!checkAuthRateLimit(`verify:${ip}`, 10, 900000)) {
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
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
    res.json({ ok: true, sessionToken, user: sanitizeUser(user) });
  }));

  app.post("/api/auth/request-magic-link", asyncHandler(async (req, res) => {
    const { email, name, company } = validateBody(magicLinkSchema, req.body);
    if (email && !checkAuthRateLimit(`magic:${email}`, 15, 3600000)) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: name || email.split("@")[0], company });
    const token = await storage.createMagicToken(email);
    await sendMagicLinkEmail(email, token);
    const isDev = !process.env.BREVO_API_KEY;
    res.json({ ok: true, ...(isDev && { token }), message: isDev ? "Dev mode: token included" : "Magic link sent to your email" });
  }));

  app.post("/api/auth/verify-magic-link", asyncHandler(async (req, res) => {
    const verifyIp = req.ip || 'unknown';
    if (!checkAuthRateLimit(`verify:${verifyIp}`, 10, 900000)) {
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    const { token } = validateBody(verifyTokenSchema, req.body);
    const email = await storage.verifyMagicToken(token);
    if (!email) return res.status(401).json({ error: "Invalid or expired token" });
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: email.split("@")[0] });
    const sessionToken = createSessionToken(user.id);
    // Set httpOnly cookie so session survives page refresh
    res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTS);
    res.json({ ok: true, sessionToken, user: sanitizeUser(user) });
  }));

  // ── GET /auth/verify/:token — one-click magic link (email → cookie → redirect) ──
  app.get("/auth/verify/:token", asyncHandler(async (req, res) => {
    const { token } = req.params;
    const email = await storage.verifyMagicToken(token);
    if (!email) {
      // Token invalid/expired → redirect to app login with error flag
      return res.redirect("/app#/login?error=expired");
    }
    let user = await storage.getUserByEmail(email);
    if (!user) user = await storage.createUser({ email, name: email.split("@")[0] });
    const sessionToken = createSessionToken(user.id);
    res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTS);
    res.redirect("/app");
  }));

  app.get("/api/auth/me", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const user = await storage.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(sanitizeUser(user));
  }));

  app.post("/api/auth/logout", asyncHandler(async (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  }));

  // ── GDPR Art. 17: Full account deletion ───────────────────────
  app.delete("/api/account", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    await storage.deleteAccount(userId);

    // Clear session cookie
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ ok: true, message: "Account and all associated data deleted" });
  }));

  // ── GDPR Art. 20: Full data export ────────────────────────────
  app.get("/api/account/export", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const format = (req.query.format as string)?.toLowerCase() || "json";

    if (format === "kmef") {
      const data = await storage.exportKMEF(userId);
      res.setHeader("Content-Disposition", 'attachment; filename="kioku-export-kmef.json"');
      res.setHeader("Content-Type", "application/json");
      return res.json(data);
    }

    if (format === "csv") {
      const csv = await storage.exportMemoriesCSV(userId);
      res.setHeader("Content-Disposition", 'attachment; filename="kioku-memories-export.csv"');
      res.setHeader("Content-Type", "text/csv");
      return res.send(csv);
    }

    // Default: JSON (original format)
    const data = await storage.exportAllUserData(userId);
    res.setHeader("Content-Disposition", 'attachment; filename="kioku-export.json"');
    res.setHeader("Content-Type", "application/json");
    res.json(data);
  }));

  // ── Stats ─────────────────────────────────────────────────────
  app.get("/api/stats", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getStats(userId));
  }));

  app.get("/api/embed/status", (_req, res) => {
    res.json({ enabled: embeddingsEnabled, model: "text-embedding-3-small" });
  });

  // ── Agents ────────────────────────────────────────────────────
  app.get("/api/agents", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentList = await storage.getAgents(userId);
    res.json(agentList.map(maskAgentApiKey));
  }));

  app.post("/api/agents", ...validateAgent, asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const [plan, counts] = await Promise.all([
      storage.getUserPlan(userId),
      storage.getUserResourceCounts(userId),
    ]);
    const limits = getLimits(plan);
    if (counts.agents >= limits.agents) {
      return res.status(429).json({ error: `Plan limit reached: ${limits.agents} agents (${plan} plan)` });
    }
    const { name: rawAgentName, description: rawAgentDesc, color, llmProvider, llmApiKey, llmModel, agentType, webhookUrl, webhookSecret } = validateBody(createAgentSchema, req.body);
    const agent = await storage.createAgent({
      userId,
      name: sanitizeHtml(rawAgentName),
      description: rawAgentDesc ? sanitizeHtml(rawAgentDesc) : null,
      color: color || "#D4AF37",
      status: "idle",
      memoriesCount: 0,
      lastActiveAt: null,
      enabled: true,
      llmProvider: llmProvider || null,
      llmApiKey: llmApiKey || null,
      llmModel: llmModel || null,
      agentType: agentType || "internal",
      webhookUrl: webhookUrl || null,
      webhookSecret: webhookSecret || null,
    });
    // Mask API key in response
    res.json(maskAgentApiKey(agent));
  }));

  // Update agent fields (name, description, color, model)
  app.patch("/api/agents/:id", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    const { name, description, color, model, role, llmProvider, llmApiKey, llmModel, agentType, webhookUrl, webhookSecret } = validateBody(updateAgentSchema, req.body);
    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (color !== undefined) updates.color = color;
    if (model !== undefined) updates.model = model;
    if (role !== undefined) updates.role = role;
    if (llmProvider !== undefined) updates.llmProvider = llmProvider;
    if (llmApiKey !== undefined) updates.llmApiKey = llmApiKey;
    if (llmModel !== undefined) updates.llmModel = llmModel;
    if (agentType !== undefined) updates.agentType = agentType;
    if (webhookUrl !== undefined) updates.webhookUrl = webhookUrl;
    if (webhookSecret !== undefined) updates.webhookSecret = webhookSecret;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No fields to update" });
    const ok = await storage.updateAgent(agentId, userId, updates);
    if (!ok) return res.status(404).json({ error: "Not found" });
    const agent = await storage.getAgent(agentId);
    res.json(maskAgentApiKey(agent));
  }));

  app.patch("/api/agents/:id/toggle", asyncHandler(async (req, res) => {
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
  }));

  // Reset agent error state (circuit breaker)
  app.post("/api/agents/:id/reset", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    const ok = await storage.resetAgentError(agentId, userId);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, message: "Agent error state reset" });
  }));

  app.delete("/api/agents/:id", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteAgent(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  }));


  // ── Webhooks (external agents) ─────────────────────────────────
  app.post("/api/agents/:id/webhook", asyncHandler(async (req, res) => {
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
  }));

  app.get("/api/agents/:id/webhook", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const wh = await storage.getWebhook(Number(req.params.id), userId);
    if (!wh) return res.status(404).json({ error: "No webhook registered" });
    res.json(wh);
  }));

  app.delete("/api/agents/:id/webhook", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteWebhook(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  }));

  app.get("/api/webhooks", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const webhooks = await storage.getWebhooksByUser(userId);
    res.json(webhooks);
  }));

  // ── Agent Tokens (external agent auth) ─────────────────────────
  app.post("/api/agents/:id/token", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    // Verify agent belongs to user
    const agent = await storage.getAgent(agentId);
    if (!agent || agent.userId !== userId) return res.status(404).json({ error: "Not found" });
    const { name, scopes, expiresInDays } = validateBody(createAgentTokenSchema, req.body || {});
    const result = await storage.createAgentToken({ agentId, userId, name, scopes, expiresInDays });
    res.json({ ok: true, ...result, note: "Save this token — it cannot be retrieved later" });
  }));

  app.get("/api/agents/:id/tokens", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const tokens = await storage.getAgentTokens(Number(req.params.id), userId);
    res.json(tokens);
  }));

  app.post("/api/agents/:id/tokens", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    const agent = await storage.getAgent(agentId);
    if (!agent || agent.userId !== userId) return res.status(404).json({ error: "Not found" });
    const { name, scopes, expiresInDays } = validateBody(createAgentTokenSchema, req.body || {});
    const result = await storage.createAgentToken({ agentId, userId, name, scopes, expiresInDays });
    res.json({ ok: true, ...result, note: "Save this token — it cannot be retrieved later" });
  }));

  app.delete("/api/agents/:id/tokens/:tokenId", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const revoked = await storage.revokeAgentToken(Number(req.params.tokenId), userId);
    if (!revoked) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  }));

  app.delete("/api/agents/:id/tokens", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    await storage.revokeAllAgentTokens(Number(req.params.id), userId);
    res.json({ ok: true });
  }));

  // ── Agent Callback (external agents authenticate with kat_* token) ──
  app.post("/api/agent-callback", asyncHandler(async (req, res) => {
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
  }));

  // Agent token validation endpoint (for external agents to verify their token)
  app.get("/api/agent-auth/verify", asyncHandler(async (req, res) => {
    const auth = await getAgentAuth(req);
    if (!auth) return res.status(401).json({ error: "Invalid or expired agent token" });
    res.json({ ok: true, agentId: auth.agentId, userId: auth.userId, scopes: auth.scopes });
  }));

  // ── Polling Mode Endpoints (external agents poll for turns) ───
  // GET /api/agent/pending-turns — returns pending turns for authenticated agent
  app.get("/api/agent/pending-turns", asyncHandler(async (req, res) => {
    const auth = await getAgentAuth(req);
    if (!auth) return res.status(401).json({ error: "Invalid or expired agent token" });
    if (!auth.scopes.includes("deliberation.respond")) {
      return res.status(403).json({ error: "Token lacks deliberation.respond scope" });
    }
    const turns = await storage.getPendingTurns(auth.agentId);
    res.json(turns);
  }));

  // GET /api/agent/turns/:turnId — get turn details
  app.get("/api/agent/turns/:turnId", asyncHandler(async (req, res) => {
    const auth = await getAgentAuth(req);
    if (!auth) return res.status(401).json({ error: "Invalid or expired agent token" });
    const turn = await storage.getAgentTurn(Number(req.params.turnId));
    if (!turn || turn.agentId !== auth.agentId) {
      return res.status(404).json({ error: "Turn not found" });
    }
    res.json(turn);
  }));

  // POST /api/agent/turns/:turnId/respond — submit agent's response
  app.post("/api/agent/turns/:turnId/respond", asyncHandler(async (req, res) => {
    const auth = await getAgentAuth(req);
    if (!auth) return res.status(401).json({ error: "Invalid or expired agent token" });
    if (!auth.scopes.includes("deliberation.respond")) {
      return res.status(403).json({ error: "Token lacks deliberation.respond scope" });
    }
    const turnId = Number(req.params.turnId);
    const turn = await storage.getAgentTurn(turnId);
    if (!turn || turn.agentId !== auth.agentId) {
      return res.status(404).json({ error: "Turn not found" });
    }
    if (turn.status !== "pending") {
      return res.status(409).json({ error: `Turn already ${turn.status}` });
    }
    if (Date.now() > turn.expiresAt) {
      return res.status(410).json({ error: "Turn expired" });
    }
    const { position, confidence, reasoning } = validateBody(agentTurnResponseSchema, req.body);
    const ok = await storage.respondToTurn(turnId, auth.agentId, {
      position,
      confidence: confidence ?? 0.5,
      reasoning: reasoning ?? "External agent response",
    });
    if (!ok) return res.status(409).json({ error: "Failed to respond — turn may have expired" });
    // Log the response
    await storage.addLog({
      userId: auth.userId,
      agentName: `External Agent #${auth.agentId}`,
      agentColor: "#9B59B6",
      operation: "polling_response",
      detail: `Turn ${turnId}: position received (confidence=${confidence ?? 0.5})`,
      latencyMs: null,
    });
    res.json({ ok: true, turnId });
  }));

  // POST /api/agents/:id/test-webhook — send a test ping to webhook URL
  app.post("/api/agents/:id/test-webhook", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentId = Number(req.params.id);
    const agent = await storage.getAgent(agentId);
    if (!agent || agent.userId !== userId) return res.status(404).json({ error: "Not found" });
    const webhookUrl = (agent as any).webhookUrl;
    const webhookSecret = (agent as any).webhookSecret;
    if (!webhookUrl || !webhookSecret) {
      return res.status(400).json({ error: "Agent has no webhook URL configured" });
    }
    try {
      const { createHmac } = await import("crypto");
      const payload = JSON.stringify({
        event: "test.ping",
        agentId,
        agentName: agent.name,
        timestamp: Date.now(),
      });
      const signature = createHmac("sha256", webhookSecret).update(payload).digest("hex");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kioku-Signature": signature,
          "X-Kioku-Event": "test.ping",
        },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const status = resp.status;
      const body = await resp.text().catch(() => "");
      res.json({ ok: status >= 200 && status < 300, status, body: body.slice(0, 500) });
    } catch (err: any) {
      res.json({ ok: false, error: err.message || "Connection failed" });
    }
  }));

  // ── Memories ──────────────────────────────────────────────────
  app.get("/api/memories", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const q = req.query.q as string;
    const namespace = req.query.namespace as string | undefined;
    const includeEmbedding = req.query.include_embedding === "true";
    const ownerUser = await isOwner(userId);
    const filterInternal = (mems: any[]) =>
      ownerUser ? mems : mems.filter((m: any) => !m.namespace || !m.namespace.startsWith('_'));

    if (q) {
      const queryEmbedding = await embedText(q);
      const results = await storage.searchMemories(userId, q, queryEmbedding ?? undefined, namespace);
      res.json(filterInternal(results).map((m: any) => stripEmbedding(m, includeEmbedding)));
    } else {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
      const offset = (page - 1) * limit;
      const [results, total] = await Promise.all([
        storage.getMemories(userId, limit, offset),
        storage.getMemoriesCount(userId),
      ]);
      const filtered = filterInternal(results);
      res.json({
        data: filtered.map((m: any) => stripEmbedding(m, includeEmbedding)),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    }
  }));

  app.post("/api/memories", ...validateMemory, asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const [memPlan, memCounts] = await Promise.all([
      storage.getUserPlan(userId),
      storage.getUserResourceCounts(userId),
    ]);
    const memLimits = getLimits(memPlan);
    if (memCounts.memories >= memLimits.memories) {
      return res.status(429).json({ error: `Plan limit reached: ${memLimits.memories} memories (${memPlan} plan)` });
    }
    const { agentId, agentName, content: rawContent, type, importance, namespace, confidence, decayRate, expiresAt, causeId, contextTrigger } = validateBody(createMemorySchema, req.body);
    const content = sanitizeHtml(rawContent);
    // Generate embedding asynchronously — don't block response
    const embedding = await embedText(content);
    const mem = await storage.createMemory({
      userId,
      agentId: agentId ?? null,
      agentName: agentName ? sanitizeHtml(agentName) : null,
      content,
      type: type ?? "semantic",
      importance: importance ?? 0.5,
      namespace: namespace ?? "default",
      embedding: embedding ? JSON.stringify(embedding) : null,
      confidence: confidence ?? 1.0,
      decayRate: decayRate ?? 0.01,
      expiresAt: expiresAt ?? null,
      causeId: causeId ?? null,
      contextTrigger: contextTrigger ?? null,
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
    const includeEmbedding = req.query.include_embedding === "true";
    res.json(stripEmbedding(mem, includeEmbedding));

    // Fire-and-forget: auto-link highly similar memories
    if (embedding) {
      storage.searchMemories(userId, content, embedding).then(async (similar) => {
        for (const sim of similar) {
          if (sim.id !== mem.id && (sim as any).similarity > 0.85) {
            await storage.createMemoryLink(userId, mem.id, sim.id, "related", (sim as any).similarity);
          }
        }
      }).catch(() => {});
    }
  }));

  // ── GDPR: Purge (Art. 17) ──────────────────────────────────────
  // NOTE: must be registered before /api/memories/:id to avoid Express matching "purge" as :id
  app.delete("/api/memories/purge", asyncHandler(async (req, res) => {
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
  }));

  // ── GDPR: Export (Art. 20) ──────────────────────────────────────
  // NOTE: must be registered before /api/memories/:id to avoid Express matching "export" as :id
  app.get("/api/memories/export", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const data = await storage.exportMemories(userId);
    res.setHeader("Content-Disposition", 'attachment; filename="kioku-export.json"');
    res.setHeader("Content-Type", "application/json");
    res.json(data);
  }));

  // GET single memory — also reinforces (bumps confidence clock)
  app.get("/api/memories/:id", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id);
    const mem = await storage.getMemory(id, userId);
    if (!mem) return res.status(404).json({ error: "Not found" });
    // Reinforce on read (fire-and-forget)
    storage.reinforceMemory(id, userId).catch(() => {});
    const includeEmbedding = req.query.include_embedding === "true";
    const now = Date.now();
    const { computeDecayedConfidence } = await import("./memory-decay");
    const currentConfidence = computeDecayedConfidence(
      (mem as any).confidence ?? 1.0,
      (mem as any).decayRate ?? 0.01,
      (mem as any).lastReinforcedAt,
      mem.createdAt,
      now
    );
    res.json(stripEmbedding({ ...mem, currentConfidence }, includeEmbedding));
  }));

  app.delete("/api/memories/:id", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteMemory(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  }));

  // ── Memory Links (synaptic connections) ──────────────────────
  app.post("/api/memories/:id/links", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const sourceId = Number(req.params.id);
    const { targetId, linkType, strength } = validateBody(createMemoryLinkSchema, req.body);
    const link = await storage.createMemoryLink(userId, sourceId, targetId, linkType, strength);
    if (!link) return res.status(404).json({ error: "Memory not found" });
    res.status(201).json(link);
  }));

  app.get("/api/memories/:id/links", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const links = await storage.getMemoryLinks(userId, Number(req.params.id));
    res.json(links);
  }));

  app.delete("/api/memories/:id/links/:linkId", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    await storage.deleteMemoryLink(userId, Number(req.params.id), Number(req.params.linkId));
    res.json({ success: true });
  }));

  // ── Graph Traversal (synaptic link BFS) ─────────────────────
  app.get("/api/memories/:id/graph", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const memoryId = Number(req.params.id);
    const depth = Math.min(Number(req.query.depth) || 2, 4);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const linked = await storage.getLinkedMemories(userId, memoryId, depth, limit);
    res.json(linked);
  }));

  // ── Memory Consolidation ────────────────────────────────────
  app.post("/api/memories/consolidate", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const result = await consolidateMemories(storage.getPool(), userId);
    res.json(result);
  }));

  // ── Memory GC (forgetting curve + confidence pruning) ────────
  app.post("/api/memories/gc", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const threshold = req.body?.threshold ?? 0.05;
    const confidenceThreshold = req.body?.confidenceThreshold ?? 0.1;
    const result = await pruneDecayedMemories(storage.getPool(), userId, threshold, confidenceThreshold);
    res.json(result);
  }));

  // ── Flows ─────────────────────────────────────────────────────
  app.get("/api/flows", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getFlows(userId));
  }));

  app.post("/api/flows", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const [flowPlan, flowCounts] = await Promise.all([
      storage.getUserPlan(userId),
      storage.getUserResourceCounts(userId),
    ]);
    const flowLimits = getLimits(flowPlan);
    if (flowCounts.flows >= flowLimits.flows) {
      return res.status(429).json({ error: `Plan limit reached: ${flowLimits.flows} flows (${flowPlan} plan)` });
    }
    const { name, description, agentIds, positions } = validateBody(createFlowSchema, req.body);
    const flow = await storage.createFlow({
      userId,
      name,
      description: description || null,
      agentIds: JSON.stringify(agentIds ?? []),
      positions: JSON.stringify(positions ?? {}),
    });
    res.json(flow);
  }));

  app.patch("/api/flows/:id", asyncHandler(async (req, res) => {
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
  }));

  app.delete("/api/flows/:id", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteFlow(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  }));

  // ── Rooms ─────────────────────────────────────────────────────
  app.get("/api/rooms", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getRooms(userId));
  }));

  app.post("/api/rooms", ...validateRoom, asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const [roomPlan, roomCounts] = await Promise.all([
      storage.getUserPlan(userId),
      storage.getUserResourceCounts(userId),
    ]);
    const roomLimits = getLimits(roomPlan);
    if (roomCounts.rooms >= roomLimits.rooms) {
      return res.status(429).json({ error: `Plan limit reached: ${roomLimits.rooms} rooms (${roomPlan} plan)` });
    }
    const { name: rawName, description: rawDesc, agentIds } = validateBody(createRoomSchema, req.body);
    const room = await storage.createRoom({
      userId,
      name: sanitizeHtml(rawName),
      description: rawDesc ? sanitizeHtml(rawDesc) : null,
      status: "standby",
      agentIds: JSON.stringify(agentIds ?? []),
    });
    res.json(room);
  }));

  app.patch("/api/rooms/:id", asyncHandler(async (req, res) => {
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
  }));

  app.delete("/api/rooms/:id", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const deleted = await storage.deleteRoom(Number(req.params.id), userId);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  }));

  // ── Room Messages ─────────────────────────────────────────────
  app.get("/api/rooms/:id/messages", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const messages = await storage.getRoomMessages(Number(req.params.id), userId);
    if (messages === null) return res.status(404).json({ error: "Not found" });
    res.json(messages);
  }));

  app.post("/api/rooms/:id/messages", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { agentId, agentName: rawMsgName, agentColor, content: rawMsgContent, isDecision } = validateBody(createRoomMessageSchema, req.body);
    const agentName = sanitizeHtml(rawMsgName);
    const content = sanitizeHtml(rawMsgContent);
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
      ).catch((e) => logger.error({ source: "deliberation", err: e }, "deliberation error"));
    }
  }));

  // ── Logs / Live Feed ──────────────────────────────────────────
  app.get("/api/logs", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    res.json(await storage.getLogs(userId));
  }));

  // ── War Room — Agent Write API ──────────────────────────────────────────
  // POST /api/warroom/message — Boss Agent or external agents write to War Room
  // Finds or creates a "War Room" room, posts message, broadcasts via WebSocket
  app.post("/api/warroom/message", asyncHandler(async (req, res) => {
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
  }));

  // ── API Key Rotation ──────────────────────────────────────────
  app.post("/api/auth/rotate-key", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (userId === 1) return res.status(403).json({ error: "Demo account key cannot be rotated" });
    const user = await storage.rotateApiKey(userId);
    res.json({ ok: true, apiKey: user?.apiKey });
  }));

  // ── Waitlist ──────────────────────────────────────────────────
  app.post("/api/waitlist", asyncHandler(async (req, res) => {
    const waitlistIp = req.ip || 'unknown';
    if (!checkAuthRateLimit(`waitlist:${waitlistIp}`, 3, 3600000)) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
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
        logger.error({ source: "waitlist", err: e }, "email error");
      }
    }
    logger.info({ source: "waitlist", email, company, useCase }, "waitlist signup");
    res.json({ ok: true, message: "You're on the waitlist. We'll be in touch." });
  }));

  // ── Tenant Self-Registration ──────────────────────────────────
  // POST /api/register — create new tenant + generate API key
  // (accessible via /api/v1/register thanks to versioning middleware)
  app.post("/api/register", asyncHandler(async (req, res) => {
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
  }));

  // ── Usage Dashboard ──────────────────────────────────────────
  // GET /api/usage — returns usage stats for authenticated API key
  // (accessible via /api/v1/usage thanks to versioning middleware)
  app.get("/api/usage", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", status: 401 });

    const user = await storage.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found", code: "NOT_FOUND", status: 404 });

    const [memoriesCount, agentsList, roomsList, stats, currentUsage, resourceCounts] = await Promise.all([
      storage.getMemoriesCount(userId),
      storage.getAgents(userId),
      storage.getRooms(userId),
      storage.getStats(userId),
      storage.getCurrentUsage(userId),
      storage.getUserResourceCounts(userId),
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
    const usageLimits = getUsageLimits(user.plan);
    const resourceLimits = getLimits(user.plan);

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
      // Metered usage this month
      metered: {
        deliberations: { used: currentUsage.deliberations, limit: usageLimits.deliberations },
        rounds: { used: currentUsage.rounds },
        api_calls: { used: currentUsage.apiCalls, limit: usageLimits.apiCalls },
        webhook_calls: { used: currentUsage.webhookCalls, limit: usageLimits.webhookCalls },
        tokens_used: { used: currentUsage.tokensUsed, limit: usageLimits.tokensUsed },
      },
      resource_limits: {
        agents: { used: resourceCounts.agents, limit: resourceLimits.agents },
        memories: { used: resourceCounts.memories, limit: resourceLimits.memories },
        rooms: { used: resourceCounts.rooms, limit: resourceLimits.rooms },
        flows: { used: resourceCounts.flows, limit: resourceLimits.flows },
      },
      period: {
        start: currentUsage.periodStart,
        end: currentUsage.periodEnd,
      },
    });
  }));

  // ── Usage history (past months) ──────────────────────────────
  app.get("/api/usage/history", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const months = Math.min(12, Math.max(1, Number(req.query.months) || 6));
    const history = await storage.getUsageHistory(userId, months);
    res.json({ history });
  }));

  // ── Billing / Plan ────────────────────────────────────────────
  app.patch("/api/billing/plan", asyncHandler(async (req, res) => {
    const masterKey = process.env.KIOKU_MASTER_KEY;
    const authHeader = req.headers["x-master-key"] || req.headers.authorization?.replace("Bearer ", "");
    if (!masterKey || !safeCompare(authHeader as string || '', masterKey)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { plan, billingCycle } = validateBody(updatePlanSchema, req.body);
    const updated = await storage.updateUserPlan(userId, plan, billingCycle ?? "monthly");
    res.json(updated);
  }));

  // ── Structured Deliberation (Phase B-1) ───────────────────────

  // Start a structured deliberation session
  app.post("/api/rooms/:id/deliberate", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const roomId = Number(req.params.id);
    // Verify room belongs to user
    const roomCheck = await storage.getRoom(roomId, userId);
    if (!roomCheck) return res.status(404).json({ error: "Not found" });
    // AI quota check
    const deliberatePlan = await storage.getUserPlan(userId);
    const quota = AI_QUOTAS[deliberatePlan] || AI_QUOTAS.free;
    const aiCheck = await storage.checkAIUsage(userId, deliberatePlan, quota.dailyCalls);
    if (!aiCheck.allowed) {
      return res.status(429).json({
        error: `Daily AI quota exceeded: ${aiCheck.used}/${aiCheck.limit} calls (${deliberatePlan} plan)`
      });
    }
    // Monthly deliberation limit check
    const currentUsage = await storage.getCurrentUsage(userId);
    const usageLimits = getUsageLimits(deliberatePlan);
    if (currentUsage.deliberations >= usageLimits.deliberations) {
      return res.status(429).json({
        error: `Plan limit reached. ${currentUsage.deliberations}/${usageLimits.deliberations} deliberations this month (${deliberatePlan} plan). Upgrade to Professional for more.`,
        code: "PLAN_LIMIT_REACHED",
      });
    }
    const { topic, model, debateRounds, includeHuman, humanName, parentDecisionId } = validateBody(deliberateSchema, req.body);
    try {
      const session = await runDeliberation(roomId, userId, topic, {
        model: model || undefined,
        debateRounds: debateRounds ?? 2,
        includeHuman: includeHuman ?? false,
        humanName: humanName || undefined,
        parentDecisionId: parentDecisionId || undefined,
      });
      // Meter deliberation usage (non-blocking)
      const roundCount = (session as any).rounds?.length ?? (debateRounds ?? 2) + 2; // position + debate rounds + final
      storage.incrementUsage(userId, 'deliberations').catch(() => {});
      storage.incrementUsage(userId, 'rounds', roundCount).catch(() => {});
      res.json(session);
    } catch (err) {
      const message = (err as Error).message;
      const status = message.includes("already running") ? 409 : 500;
      res.status(status).json({ error: message });
    }
  }));

  // Submit human participant input during a deliberation
  app.post("/api/rooms/:id/deliberations/:sessionId/human-input", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const roomId = Number(req.params.id);
    const room = await storage.getRoom(roomId, userId);
    if (!room) return res.status(404).json({ error: "Not found" });

    const { phase, round, position, confidence, reasoning } = validateBody(humanInputSchema, req.body);
    const accepted = submitHumanInput(
      String(req.params.sessionId),
      phase,
      round,
      { position, confidence, reasoning: reasoning || "" }
    );

    if (!accepted) {
      return res.status(410).json({ error: "No pending human input for this phase/round (expired or already submitted)" });
    }

    res.json({ accepted: true });
  }));

  // Get deliberation session by ID
  app.get("/api/rooms/:id/deliberations/:sessionId", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    // Verify room belongs to user
    const room = await storage.getRoom(Number(req.params.id), userId);
    if (!room) return res.status(404).json({ error: "Not found" });
    const session = await getSession(String(req.params.sessionId));
    if (!session || session.roomId !== Number(req.params.id)) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json(session);
  }));

  // List all deliberation sessions for a room
  app.get("/api/rooms/:id/deliberations", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    // Verify room belongs to user
    const room = await storage.getRoom(Number(req.params.id), userId);
    if (!room) return res.status(404).json({ error: "Not found" });
    const sessions = await getSessionsByRoom(Number(req.params.id));
    res.json(sessions);
  }));

  // Get latest consensus for a room
  app.get("/api/rooms/:id/consensus", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    // Verify room belongs to user
    const room = await storage.getRoom(Number(req.params.id), userId);
    if (!room) return res.status(404).json({ error: "Not found" });
    const consensus = await getLatestConsensus(Number(req.params.id));
    if (!consensus) return res.status(404).json({ error: "No consensus found" });
    res.json(consensus);
  }));

  // ── Decision Provenance Chain ─────────────────────────────────

  // Get full provenance chain for a decision (ancestors + descendants)
  app.get("/api/deliberation/provenance/:decisionId", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const decisionId = String(req.params.decisionId);
    const result = await getProvenanceChain(decisionId);
    if (!result) return res.status(404).json({ error: "Decision not found" });
    // Verify the decision belongs to the user
    if (result.decision.userId !== userId) return res.status(404).json({ error: "Decision not found" });
    res.json(result);
  }));

  // Get provenance tree showing how a decision branched into follow-ups
  app.get("/api/deliberation/provenance/:decisionId/tree", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const decisionId = String(req.params.decisionId);
    // First check the decision exists and belongs to user
    const session = await getSession(decisionId);
    if (!session) return res.status(404).json({ error: "Decision not found" });
    if ((session as any).userId !== userId) return res.status(404).json({ error: "Decision not found" });
    const tree = await getProvenanceTree(decisionId);
    if (!tree) return res.status(404).json({ error: "Decision not found" });
    res.json(tree);
  }));

  // ── Agent Templates (Onboarding Quick Start) ──────────────────
  const AGENT_TEMPLATES: Record<string, { name: string; roomName: string; agents: Array<{ name: string; role: string; model: string; color: string; description: string }> }> = {
    "executive-board": {
      name: "Executive Board",
      roomName: "Executive Board Room",
      agents: [
        { name: "CFO-Agent", role: "finance", model: "gpt-4o", color: "#4ade80", description: "Financial analysis, budget approvals, cost optimization" },
        { name: "Legal-Agent", role: "legal", model: "gpt-4o", color: "#60a5fa", description: "Contract review, compliance checks, regulatory analysis" },
        { name: "Strategy-Agent", role: "strategy", model: "gpt-4o", color: "#c084fc", description: "Market research, competitive intelligence, growth planning" },
        { name: "Ops-Agent", role: "operations", model: "gpt-4o", color: "#f59e0b", description: "Infrastructure, process optimization, risk management" },
      ],
    },
    "product-team": {
      name: "Product Team",
      roomName: "Product Team Room",
      agents: [
        { name: "PM-Agent", role: "product", model: "gpt-4o", color: "#34d399", description: "Product roadmap, feature prioritization, user stories" },
        { name: "Design-Agent", role: "design", model: "gpt-4o", color: "#f472b6", description: "UX research, design systems, accessibility reviews" },
        { name: "Engineering-Agent", role: "engineering", model: "gpt-4o", color: "#38bdf8", description: "Architecture decisions, technical feasibility, code quality" },
      ],
    },
    "advisory-council": {
      name: "Advisory Council",
      roomName: "Advisory Council Room",
      agents: [
        { name: "Risk-Agent", role: "risk", model: "gpt-4o", color: "#ef4444", description: "Risk assessment, scenario planning, mitigation strategies" },
        { name: "Innovation-Agent", role: "innovation", model: "gpt-4o", color: "#a78bfa", description: "Emerging tech evaluation, R&D recommendations, patents" },
        { name: "Market-Agent", role: "market", model: "gpt-4o", color: "#fb923c", description: "Market analysis, customer insights, pricing strategy" },
      ],
    },
  };

  // GET all templates (for frontend)
  app.get("/api/agents/templates", asyncHandler(async (_req, res) => {
    const templates = Object.entries(AGENT_TEMPLATES).map(([id, t]) => ({
      id,
      name: t.name,
      agents: t.agents.map(a => ({ name: a.name, role: a.role, color: a.color, description: a.description })),
    }));
    res.json(templates);
  }));

  // POST create agents from template + default room
  app.post("/api/agents/templates/:templateId", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const template = AGENT_TEMPLATES[req.params.templateId];
    if (!template) return res.status(404).json({ error: "Template not found" });

    // Check plan limits
    const [plan, counts] = await Promise.all([
      storage.getUserPlan(userId),
      storage.getUserResourceCounts(userId),
    ]);
    const limits = getLimits(plan);
    if (counts.agents + template.agents.length > limits.agents) {
      return res.status(429).json({ error: `Would exceed plan limit: ${limits.agents} agents (${plan} plan). Need ${template.agents.length} slots, have ${limits.agents - counts.agents}.` });
    }

    // Create all agents
    const createdAgents = [];
    for (const agentDef of template.agents) {
      const agent = await storage.createAgent({
        userId,
        name: agentDef.name,
        description: agentDef.description,
        color: agentDef.color,
        model: agentDef.model,
        role: agentDef.role,
        status: "idle",
        memoriesCount: 0,
        lastActiveAt: null,
        enabled: true,
        llmProvider: null,
        llmApiKey: null,
        llmModel: null,
      });
      createdAgents.push(agent);
    }

    // Create a room with all the new agents
    const room = await storage.createRoom({
      userId,
      name: template.roomName,
      description: `${template.name} deliberation room`,
      status: "standby",
      agentIds: JSON.stringify(createdAgents.map(a => a.id)),
    });

    // Log it
    await storage.addLog({
      userId,
      agentName: "System",
      agentColor: "#D4AF37",
      operation: "template_created",
      detail: `Created ${template.name} team (${createdAgents.length} agents) + room`,
      latencyMs: null,
    });

    res.json({
      ok: true,
      template: req.params.templateId,
      agents: createdAgents.map(maskAgentApiKey),
      room,
    });
  }));

  // ── Metrics (auth required) ───────────────────────────────────
  app.get("/api/metrics", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { pool } = await import("./storage");
    const user = await storage.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Requests today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const apiKeyPrefix = user.apiKey.slice(0, 12) + "…";

    const [todayResult, avgLatencyResult, errorResult, memoriesResult] = await Promise.all([
      pool.query(
        "SELECT COUNT(*)::int as cnt FROM kioku_request_logs WHERE api_key_id = $1 AND timestamp >= $2",
        [apiKeyPrefix, todayStart.getTime()]
      ),
      pool.query(
        "SELECT ROUND(AVG(latency_ms))::int as avg_ms FROM kioku_request_logs WHERE api_key_id = $1 AND timestamp >= $2",
        [apiKeyPrefix, todayStart.getTime()]
      ),
      pool.query(
        "SELECT COUNT(*)::int as cnt FROM kioku_request_logs WHERE api_key_id = $1 AND timestamp >= $2 AND status_code >= 500",
        [apiKeyPrefix, Date.now() - 3600_000]
      ),
      pool.query(
        "SELECT COUNT(*)::int as cnt FROM memories WHERE user_id = $1",
        [userId]
      ),
    ]);

    const requestsToday = todayResult.rows[0]?.cnt ?? 0;
    const errorsLastHour = errorResult.rows[0]?.cnt ?? 0;
    const errorRate = requestsToday > 0
      ? parseFloat(((errorsLastHour / requestsToday) * 100).toFixed(2))
      : 0;

    res.json({
      active_ws_connections: getActiveWsConnectionCount(),
      requests_today: requestsToday,
      avg_response_time_ms: avgLatencyResult.rows[0]?.avg_ms ?? 0,
      active_deliberations: getActiveDeliberationCount(),
      memory_count: memoriesResult.rows[0]?.cnt ?? 0,
      error_rate_pct: errorRate,
      errors_last_hour: errorsLastHour,
      timestamp: new Date().toISOString(),
    });
  }));

  // ── Boss Board: Admin Status (owner-only) ─────────────────────
  app.get("/api/admin/status", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!(await isOwner(userId))) return res.status(403).json({ error: "Forbidden" });

    try {
    const user = await storage.getUserById(userId);

    // Health check
    let dbStatus = "connected";
    try { await pool.query("SELECT 1"); } catch { dbStatus = "disconnected"; }

    // Redis status
    let redisStatus = "not configured";
    try {
      const mod = await import("./ratelimit");
      if (typeof mod.getRedisStatus === "function") redisStatus = await mod.getRedisStatus();
    } catch { /* no redis module */ }

    // Usage data — each wrapped to avoid single failure breaking all
    let memoriesCount = 0, agentsList: any[] = [], roomsList: any[] = [], flowsList: any[] = [];
    let currentUsage = { deliberations: 0, rounds: 0, apiCalls: 0, tokensUsed: 0 };
    let resourceCounts = { agents: 0, memories: 0, rooms: 0, flows: 0 };
    try { memoriesCount = await storage.getMemoriesCount(userId); } catch {}
    try { agentsList = await storage.getAgents(userId); } catch {}
    try { roomsList = await storage.getRooms(userId); } catch {}
    try { flowsList = await storage.getFlows(userId); } catch {}
    try { currentUsage = await storage.getCurrentUsage(userId) as any; } catch {}
    try { resourceCounts = await storage.getUserResourceCounts(userId); } catch {}

    // Request logs
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    let todayRequests = { rows: [{ cnt: "0" }] };
    let recentLogs: any[] = [];
    let recentSessions = { rows: [] as any[] };
    let totalUsers = { rows: [{ cnt: "0" }] };
    let totalApiKeys = { rows: [{ cnt: "0" }] };
    try {
      [todayRequests, recentLogs, recentSessions, totalUsers, totalApiKeys] = await Promise.all([
        pool.query("SELECT COUNT(*) as cnt FROM kioku_request_logs WHERE timestamp >= $1", [todayStart.getTime()]),
        storage.getRequestLogs({ limit: 10 }),
        pool.query(
          `SELECT id, room_id, topic, status, model, started_at, completed_at
           FROM kioku_deliberation_sessions
           WHERE user_id = $1 ORDER BY started_at DESC LIMIT 5`, [userId]
        ),
        pool.query("SELECT COUNT(*) as cnt FROM users"),
        pool.query("SELECT COUNT(*) as cnt FROM kioku_agent_tokens WHERE revoked = false"),
      ]);
    } catch {}

    res.json({
      health: {
        status: dbStatus === "connected" ? "ok" : "degraded",
        database: dbStatus,
        redis: redisStatus,
        uptime: Math.floor(process.uptime()),
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        active_ws_connections: getActiveWsConnectionCount(),
        active_deliberations: getActiveDeliberationCount(),
      },
      usage: {
        memories: { count: memoriesCount, limit: resourceCounts.memories },
        agents: { count: agentsList.length, limit: resourceCounts.agents },
        rooms: { count: roomsList.length, limit: resourceCounts.rooms },
        flows: { count: flowsList.length, limit: resourceCounts.flows },
        requests_today: parseInt(todayRequests.rows[0]?.cnt ?? "0"),
        metered: {
          deliberations: currentUsage.deliberations,
          rounds: currentUsage.rounds,
          api_calls: currentUsage.apiCalls,
          tokens_used: currentUsage.tokensUsed,
        },
      },
      account: {
        plan: user?.plan ?? "dev",
        email: user?.email,
        total_users: parseInt(totalUsers.rows[0]?.cnt ?? "0"),
      },
      security: {
        active_api_keys: parseInt(totalApiKeys.rows[0]?.cnt ?? "0"),
      },
      recent_activity: {
        api_calls: (Array.isArray(recentLogs) ? recentLogs : (recentLogs as any)?.logs ?? []).map((l: any) => ({
          timestamp: l.timestamp,
          method: l.method,
          path: l.path,
          status: l.statusCode,
          latency_ms: l.latencyMs,
        })),
        deliberations: recentSessions.rows.map((s: any) => ({
          id: s.id,
          topic: s.topic,
          status: s.status,
          model: s.model,
          started_at: s.started_at,
          completed_at: s.completed_at,
        })),
      },
    });
    } catch (err: any) {
      logger.error({ source: "boss-board", err }, "admin status error");
      res.status(500).json({ error: "Boss Board error", details: err?.message ?? "unknown" });
    }
  }));

  // ── Partner / Emotional State API ─────────────────────────────

  // GET /api/agents/:agentId/emotional-state — returns current emotional state with decay applied
  app.get("/api/agents/:agentId/emotional-state", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const agentId = Number(req.params.agentId);
    if (isNaN(agentId)) return res.status(400).json({ error: "Invalid agentId" });

    // Verify agent belongs to user
    const agent = await storage.getAgent(agentId);
    if (!agent || agent.userId !== userId) return res.status(404).json({ error: "Agent not found" });

    const state = await storage.getAgentEmotionalState(agentId);
    if (!state) {
      // Return default state if none exists
      return res.json({
        agentId,
        pleasure: 0.0,
        arousal: 0.0,
        dominance: 0.0,
        emotionLabel: "neutral",
        poignancySum: 0,
        lastUpdatedAt: Date.now(),
      });
    }

    const { getDecayedEmotionalState: getDecayed } = await import("./emotional-state");
    const decayed = getDecayed(state);
    res.json({
      agentId: state.agentId,
      pleasure: decayed.pleasure,
      arousal: decayed.arousal,
      dominance: decayed.dominance,
      emotionLabel: decayed.emotionLabel,
      poignancySum: state.poignancySum,
      lastUpdatedAt: state.lastUpdatedAt,
    });
  }));

  // GET /api/agents/:agentId/relationship/:userId — returns relationship data
  app.get("/api/agents/:agentId/relationship/:targetUserId", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const agentId = Number(req.params.agentId);
    const targetUserId = Number(req.params.targetUserId);
    if (isNaN(agentId) || isNaN(targetUserId)) return res.status(400).json({ error: "Invalid IDs" });

    // Verify agent belongs to user
    const agent = await storage.getAgent(agentId);
    if (!agent || agent.userId !== userId) return res.status(404).json({ error: "Agent not found" });

    const rel = await storage.getRelationship(agentId, targetUserId);
    if (!rel) {
      return res.json({
        trustLevel: 0,
        familiarity: 0,
        interactionCount: 0,
        sharedReferences: [],
        emotionalHistory: [],
      });
    }

    res.json({
      trustLevel: rel.trustLevel,
      familiarity: rel.familiarity,
      interactionCount: rel.interactionCount,
      sharedReferences: rel.sharedReferences,
      emotionalHistory: rel.emotionalHistory,
    });
  }));

  // GET /api/partner/status — combined emotional state + relationship for logged-in user's primary agent
  app.get("/api/partner/status", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Find user's first agent (Agent O / primary partner)
    const agents = await storage.getAgents(userId);
    const primaryAgent = agents.find((a: any) =>
      a.name.toLowerCase().includes("agent o") ||
      a.name.toLowerCase().includes("partner")
    ) || agents[0];

    if (!primaryAgent) {
      return res.json({
        emotion: "neutral",
        pad: { p: 0, a: 0, d: 0 },
        trust: "new",
        familiarity: "stranger",
        interactions: 0,
        personality: "honest, direct, slightly playful",
      });
    }

    // Get emotional state with decay
    const state = await storage.getAgentEmotionalState(primaryAgent.id);
    let emotion = "neutral";
    let pad = { p: 0, a: 0, d: 0 };

    if (state) {
      const { getDecayedEmotionalState: getDecayed } = await import("./emotional-state");
      const decayed = getDecayed(state);
      emotion = decayed.emotionLabel;
      pad = { p: decayed.pleasure, a: decayed.arousal, d: decayed.dominance };
    }

    // Get relationship
    const rel = await storage.getRelationship(primaryAgent.id, userId);
    const trustLevel = rel?.trustLevel ?? 0;
    const familiarityLevel = rel?.familiarity ?? 0;
    const interactions = rel?.interactionCount ?? 0;

    // Map trust/familiarity to human-readable labels
    const trustLabel = trustLevel > 0.7 ? "high" : trustLevel > 0.3 ? "moderate" : "new";
    const familiarityLabel = familiarityLevel > 0.7 ? "close" : familiarityLevel > 0.3 ? "familiar" : "stranger";

    res.json({
      emotion,
      pad,
      trust: trustLabel,
      familiarity: familiarityLabel,
      interactions,
      personality: "honest, direct, slightly playful",
    });
  }));

  // ── Phase 5: Sensory Endpoints — TTS, STT, Vision ─────────────

  // POST /api/partner/speak — Text-to-Speech via OpenAI TTS
  app.post("/api/partner/speak", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { text, voice } = req.body;
    if (!text) return res.status(400).json({ error: "Text required" });

    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI();
    const mp3 = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voice || "nova",
      input: text.slice(0, 4096),
      instructions: "Speak naturally, as a friendly partner having a conversation. Match emotional tone to the content.",
    });

    res.set("Content-Type", "audio/mpeg");
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.send(buffer);
  }));

  // POST /api/partner/listen — Speech-to-Text via Whisper
  app.post("/api/partner/listen", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const multer = (await import("multer")).default;
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }).single("audio");

    await new Promise<void>((resolve, reject) => {
      upload(req as any, res as any, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "Audio file required" });

    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI();
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: new File([file.buffer], file.originalname || "audio.webm", { type: file.mimetype || "audio/webm" }),
      language: "en",
    });

    res.json({ text: transcription.text });
  }));

  // POST /api/partner/see — Vision via GPT-4o-mini
  app.post("/api/partner/see", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { image, prompt } = req.body;
    if (!image) return res.status(400).json({ error: "Image required" });

    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI();
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt || "What do you see in this image? Describe it naturally as a friend would." },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
        ],
      }],
      max_tokens: 500,
    });

    const description = response.choices[0]?.message?.content || "I couldn't make out the image clearly.";
    res.json({ description });
  }));

  // ── Global error handler ──────────────────────────────────────
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error({ source: "routes", err }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  return httpServer;
}
