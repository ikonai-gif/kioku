/**
 * PR-A.5 — Telegram inbound webhook tests.
 *
 * Two-layer strategy:
 *
 *   A) UNIT — exercise the pure helpers exported from
 *      server/lib/telegram-inbound.ts directly (verifyTelegramSecret,
 *      parseCommand, checkInboundRateLimit, buildHelpReply,
 *      buildStatusReply, buildQueueReply, handleCancelCommand,
 *      handleTelegramCommand). No Express app, no DB.
 *
 *   B) ROUTE — mount a minimal Express app that mirrors the POST
 *      /api/telegram/webhook block from server/routes.ts, with `db`,
 *      `storage`, `sendTelegramMessage`, ws-broadcast, deliberation, and
 *      logger all mocked. Verifies the full pipeline (secret → schema →
 *      allowlist → idempotency → rate-limit → dispatch).
 *
 * Why mirror instead of importing registerRoutes(): registerRoutes pulls
 * the entire dependency graph (auth, billing, MCP, Brevo, Twilio, Stripe,
 * VAPID, ...). The pipeline contract under test is small and self-
 * contained; mirroring is the same pattern rate-limit-beta.test.ts and
 * ratelimit-internal-health-bypass.test.ts already use in this repo.
 *
 * The 17 cases requested by the PR-A.5 prompt are all covered, organised
 * by concern (auth/schema, idempotency, rate-limit, dispatch, commands).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks for "../storage" so importing telegram-inbound.ts is safe ──
//
// vi.mock factories run BEFORE the SUT imports execute, so they must be
// self-contained (no closures over outer-scope vars). We control their
// behaviour via vi.mocked(...) inside each test.
vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = vi.fn();
    this.on = vi.fn();
    this.end = vi.fn().mockResolvedValue(undefined);
    this.connect = vi.fn();
  }
  return { Pool: MockPool };
});
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));

vi.mock("../storage", () => {
  // db.insert(...).values(...).onConflictDoNothing(...).returning() and
  // db.update(...).set(...).where(...) chains both need to terminate in
  // thenable-ish results. We expose a per-test controllable shape.
  const dbState: {
    insertReturning: Array<{ id: number }>;
    insertImpl: ((...args: any[]) => any) | null;
    updateImpl: ((...args: any[]) => any) | null;
  } = { insertReturning: [{ id: 1 }], insertImpl: null, updateImpl: null };

  const insertChain = (vals: any) => ({
    onConflictDoNothing: (_: any) => ({
      returning: (_cols?: any) => {
        if (dbState.insertImpl) return dbState.insertImpl(vals);
        return Promise.resolve(dbState.insertReturning);
      },
    }),
  });

  const updateChain = () => ({
    set: (_setVals: any) => ({
      where: (_cond: any) => {
        if (dbState.updateImpl) return Promise.resolve(dbState.updateImpl(_setVals));
        return Promise.resolve(undefined);
      },
    }),
  });

  return {
    pool: { query: vi.fn() },
    db: {
      insert: vi.fn().mockImplementation((_table: any) => ({ values: (vals: any) => insertChain(vals) })),
      update: vi.fn().mockImplementation((_table: any) => updateChain()),
    },
    storage: {
      getRooms: vi.fn(),
      addRoomMessage: vi.fn(),
      getScheduledTasks: vi.fn(),
      updateScheduledTask: vi.fn(),
    },
    getToolActivityForMessage: vi.fn(),
    __dbState: dbState,
  };
});

vi.mock("../logger", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// drizzle-orm `eq` is used by routes.ts; provide a passthrough that returns
// the args so where(...) can still be called in mocks.
vi.mock("drizzle-orm", async (orig) => {
  const real = (await orig()) as any;
  return { ...real, eq: vi.fn((...args: any[]) => ({ __eq: args })) };
});

import express from "express";
import request from "supertest";

import {
  verifyTelegramSecret,
  parseCommand,
  checkInboundRateLimit,
  __resetInboundRateLimitForTests,
  telegramUpdateSchema,
  buildHelpReply,
  buildStatusReply,
  buildQueueReply,
  handleCancelCommand,
  handleTelegramCommand,
  findBossPartnerRoom,
  BOSS_USER_ID,
} from "../lib/telegram-inbound";

import { storage, db } from "../storage";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION A — UNIT TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe("PR-A.5 unit · verifyTelegramSecret", () => {
  beforeEach(() => { delete process.env.TELEGRAM_WEBHOOK_SECRET; });

  it("(1) secret mismatch → false (route maps to 401)", () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "expected-secret-aaa";
    expect(verifyTelegramSecret("wrong-secret")).toBe(false);
  });

  it("matching secret → true", () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "expected-secret-bbb";
    expect(verifyTelegramSecret("expected-secret-bbb")).toBe(true);
  });

  it("missing env → false (fail-closed)", () => {
    expect(verifyTelegramSecret("anything")).toBe(false);
  });

  it("missing header → false", () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "x";
    expect(verifyTelegramSecret(undefined)).toBe(false);
    expect(verifyTelegramSecret("")).toBe(false);
  });

  it("array header (Express 5 may pass string[]) → uses first", () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "shared";
    expect(verifyTelegramSecret(["shared", "ignored"])).toBe(true);
    expect(verifyTelegramSecret(["nope", "shared"])).toBe(false);
  });
});

describe("PR-A.5 unit · parseCommand", () => {
  it("/status → command:status, no args", () => {
    expect(parseCommand("/status")).toEqual({ command: "status", args: [], rawArgs: "" });
  });
  it("/cancel 42 → command:cancel, args:[42]", () => {
    expect(parseCommand("/cancel 42")).toEqual({ command: "cancel", args: ["42"], rawArgs: "42" });
  });
  it("strips @botname suffix", () => {
    expect(parseCommand("/help@MyBot")).toEqual({ command: "help", args: [], rawArgs: "" });
  });
  it("non-command text → null", () => {
    expect(parseCommand("hello there")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });
  it("lower-cases command name", () => {
    expect(parseCommand("/Status")?.command).toBe("status");
  });
});

describe("PR-A.5 unit · checkInboundRateLimit", () => {
  beforeEach(() => __resetInboundRateLimitForTests());

  it("(5) 11th message in 60s → false (drop)", () => {
    const chatId = 12345;
    for (let i = 0; i < 10; i++) expect(checkInboundRateLimit(chatId)).toBe(true);
    expect(checkInboundRateLimit(chatId)).toBe(false);
  });

  it("different chat IDs don't share the bucket", () => {
    for (let i = 0; i < 10; i++) checkInboundRateLimit(111);
    expect(checkInboundRateLimit(111)).toBe(false);
    expect(checkInboundRateLimit(222)).toBe(true); // independent
  });
});

describe("PR-A.5 unit · telegramUpdateSchema", () => {
  it("(2) malformed payload → safeParse fails", () => {
    const r = telegramUpdateSchema.safeParse({ junk: true });
    expect(r.success).toBe(false);
  });
  it("valid update_id only (no message) → success, message undefined", () => {
    const r = telegramUpdateSchema.safeParse({ update_id: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.message).toBeUndefined();
  });
  it("full message payload parses", () => {
    const r = telegramUpdateSchema.safeParse({
      update_id: 99, message: { from: { id: 388621843 }, chat: { id: 388621843 }, text: "hi" },
    });
    expect(r.success).toBe(true);
  });
});

describe("PR-A.5 unit · command helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_URL;
    delete process.env.INTERNAL_HEALTH_SECRET;
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
  });

  it("(13) /help reply lists all commands", () => {
    const help = buildHelpReply();
    expect(help).toMatch(/\/status/);
    expect(help).toMatch(/\/queue/);
    expect(help).toMatch(/\/cancel/);
    expect(help).toMatch(/\/help/);
  });

  it("(8) /status fetches /api/status with X-Internal-Health and includes commit", async () => {
    process.env.PUBLIC_URL = "http://localhost:5000";
    process.env.INTERNAL_HEALTH_SECRET = "secret-xyz";
    process.env.RAILWAY_GIT_COMMIT_SHA = "abcdef1234567";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ status: "ok", db: "up", uptime_sec: 3700, version: "1.0.0",
        last_check: { at: 1, ok: true, blocking_drift_count: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const reply = await buildStatusReply();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:5000/api/status",
      expect.objectContaining({ headers: expect.objectContaining({ "X-Internal-Health": "secret-xyz" }) }),
    );
    expect(reply).toMatch(/Статус: ok/);
    expect(reply).toMatch(/БД: up/);
    expect(reply).toMatch(/abcdef1/); // 7-char commit
    fetchSpy.mockRestore();
  });

  it("/status handles fetch failure gracefully", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONN"));
    const reply = await buildStatusReply();
    expect(reply).toMatch(/недоступен/);
    fetchSpy.mockRestore();
  });

  it("(9) /queue empty → 'Очередь пуста'", async () => {
    vi.mocked(storage.getScheduledTasks).mockResolvedValue([]);
    const reply = await buildQueueReply();
    expect(reply).toBe("Очередь пуста.");
    expect(storage.getScheduledTasks).toHaveBeenCalledWith(BOSS_USER_ID);
  });

  it("(10) /queue with mixed-status tasks → only active+pending, max 10", async () => {
    const tasks = [
      { id: 1, status: "active",    title: "morning sync" },
      { id: 2, status: "completed", title: "old job" },
      { id: 3, status: "pending",   title: "schedule X" },
      { id: 4, status: "cancelled", title: "ignored" },
    ];
    vi.mocked(storage.getScheduledTasks).mockResolvedValue(tasks);
    const reply = await buildQueueReply();
    expect(reply).toMatch(/#1.*active.*morning sync/);
    expect(reply).toMatch(/#3.*pending.*schedule X/);
    expect(reply).not.toMatch(/old job/);
    expect(reply).not.toMatch(/ignored/);
  });

  it("(11) /cancel valid id → 'отменена'", async () => {
    vi.mocked(storage.updateScheduledTask).mockResolvedValue({ id: 7, status: "cancelled" });
    const reply = await handleCancelCommand("7");
    expect(reply).toBe("Задача #7 отменена.");
    expect(storage.updateScheduledTask).toHaveBeenCalledWith(7, BOSS_USER_ID, { status: "cancelled" });
  });

  it("(12) /cancel invalid id → 'не найдена'", async () => {
    vi.mocked(storage.updateScheduledTask).mockResolvedValue(undefined);
    const reply = await handleCancelCommand("999");
    expect(reply).toBe("Задача #999 не найдена.");
  });

  it("/cancel with no arg → usage hint", async () => {
    const reply = await handleCancelCommand("");
    expect(reply).toMatch(/Использование/);
  });

  it("/cancel with non-numeric arg → 'число'", async () => {
    const reply = await handleCancelCommand("abc");
    expect(reply).toMatch(/числом/);
  });

  it("(14) handleTelegramCommand routes unknown command to 'Неизвестная'", async () => {
    const reply = await handleTelegramCommand({ command: "wat", args: [], rawArgs: "" });
    expect(reply).toMatch(/Неизвестная команда/);
    expect(reply).toMatch(/\/wat/);
  });

  it("handleTelegramCommand routes /help", async () => {
    const reply = await handleTelegramCommand({ command: "help", args: [], rawArgs: "" });
    expect(reply).toMatch(/\/status/);
  });
});

describe("PR-A.5 unit · findBossPartnerRoom", () => {
  beforeEach(() => vi.clearAllMocks());

  it("(7) no Partner room → throws 'partner_room_not_found'", async () => {
    const fakeStorage = { getRooms: vi.fn().mockResolvedValue([]) };
    await expect(findBossPartnerRoom(fakeStorage as any)).rejects.toThrow("partner_room_not_found");
  });

  it("matching Partner room → returns roomId + parsed agentIds", async () => {
    const fakeStorage = { getRooms: vi.fn().mockResolvedValue([
      { id: 5, name: "Partner", purpose: "user", agentIds: "[42,43]" },
    ]) };
    const room = await findBossPartnerRoom(fakeStorage as any);
    expect(room).toEqual({ roomId: 5, agentIds: [42, 43], name: "Partner" });
  });

  it("corrupted agentIds JSON falls back to []", async () => {
    const fakeStorage = { getRooms: vi.fn().mockResolvedValue([
      { id: 5, name: "Partner", purpose: "user", agentIds: "{not json" },
    ]) };
    const room = await findBossPartnerRoom(fakeStorage as any);
    expect(room.agentIds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION B — ROUTE-LEVEL TESTS (mirror of POST /api/telegram/webhook)
// ─────────────────────────────────────────────────────────────────────────────
//
// We can't import registerRoutes() without booting the entire app graph.
// Instead, we re-build the handler here using the same helpers + the same
// ordering the production route uses. If anyone changes the production
// pipeline order, the integration tests on the deployed env (Railway smoke
// tests) will catch it; the unit coverage above pins the helper contracts.
// ─────────────────────────────────────────────────────────────────────────────

const sendTelegramMock = vi.fn().mockResolvedValue({ ok: true });
const broadcastToRoomMock = vi.fn();
const broadcastTelegramInboundEventMock = vi.fn();
const triggerAgentResponsesMock = vi.fn().mockResolvedValue(undefined);

function buildMirrorApp() {
  const app = express();
  app.use(express.json());

  app.post("/api/telegram/webhook", async (req, res) => {
    try {
      // 1. secret
      if (!verifyTelegramSecret(req.headers["x-telegram-bot-api-secret-token"])) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
      // 2. schema
      const parsed = telegramUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(200).json({ ok: true, dropped: "malformed" });
      if (!parsed.data.message) return res.status(200).json({ ok: true, dropped: "non_message_update" });

      const update = parsed.data;
      const message = update.message!;
      const chatId = message.chat.id;
      const text = message.text;

      // 3. allowlist
      const expected = Number(process.env.TELEGRAM_BOSS_CHAT_ID);
      if (!Number.isFinite(expected) || chatId !== expected) {
        return res.status(200).json({ ok: true, dropped: "rejected_chat_id" });
      }

      // 4. idempotency
      const inserted: Array<{ id: number }> = await db.insert(/* table */ {} as any)
        .values({ updateId: update.update_id, chatId, fromId: message.from.id, messageText: text ?? null, rawUpdate: update as any })
        .onConflictDoNothing({})
        .returning({ id: 0 as any });
      if (inserted.length === 0) return res.status(200).json({ ok: true, duplicate: true });
      const logRowId = inserted[0].id;

      // 5. rate-limit
      if (!checkInboundRateLimit(chatId)) {
        return res.status(200).json({ ok: true, dropped: "rate_limit" });
      }

      // 6a. non-text
      if (!text) {
        await sendTelegramMock({ chatId: String(chatId), text: "Пока поддерживается только текст. Photo/voice/file — в следующей версии.",
          urgency: "low", userId: BOSS_USER_ID, reason: "non_text_dropped" });
        return res.status(200).json({ ok: true, dropped: "non_text" });
      }

      // 6b. dispatch
      const cmd = parseCommand(text);
      if (cmd) {
        const reply = await handleTelegramCommand(cmd);
        await sendTelegramMock({ chatId: String(chatId), text: reply, urgency: "high", userId: BOSS_USER_ID, reason: `command:${cmd.command}` });
        broadcastTelegramInboundEventMock({ userId: BOSS_USER_ID, kind: "command", text: text.slice(0, 200), command: cmd.command, args: cmd.args, timestamp: new Date() });
        return res.status(200).json({ ok: true, command: cmd.command });
      }

      // free-form
      try {
        const partner = await findBossPartnerRoom(storage as any);
        const truncated = text.trim().slice(0, 4096);
        const msg = await storage.addRoomMessage({
          roomId: partner.roomId, agentId: null, agentName: "👤 BOSS (Telegram)",
          agentColor: "#3B82F6", content: truncated,
        } as any, BOSS_USER_ID);
        if (msg) broadcastToRoomMock(partner.roomId, msg);
        triggerAgentResponsesMock(partner.roomId, BOSS_USER_ID, null, "BOSS", truncated, partner.agentIds, "Partner");
        broadcastTelegramInboundEventMock({ userId: BOSS_USER_ID, kind: "message", text: text.slice(0, 200), timestamp: new Date() });
        return res.status(200).json({ ok: true });
      } catch (err: any) {
        if (err?.message === "partner_room_not_found") {
          await sendTelegramMock({ chatId: String(chatId), text: "Лука не настроен. Создай partner-room в dashboard сначала.",
            urgency: "high", userId: BOSS_USER_ID, reason: "partner_room_not_found" });
          return res.status(503).json({ ok: false, error: "partner_room_not_found" });
        }
        throw err;
      }
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "internal" });
    }
  });

  return app;
}

describe("PR-A.5 route · POST /api/telegram/webhook", () => {
  let app: express.Express;
  let dbState: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetInboundRateLimitForTests();
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.TELEGRAM_BOSS_CHAT_ID = "388621843";
    // Reset db mock state to "insert succeeds, returns row id 1"
    const storageMod = await import("../storage");
    dbState = (storageMod as any).__dbState;
    dbState.insertReturning = [{ id: 1 }];
    dbState.insertImpl = null;
    dbState.updateImpl = null;
    sendTelegramMock.mockClear();
    broadcastToRoomMock.mockClear();
    broadcastTelegramInboundEventMock.mockClear();
    triggerAgentResponsesMock.mockClear();
    app = buildMirrorApp();
  });

  function makeUpdate(text: string | undefined = "hi", overrides: any = {}) {
    return {
      update_id: overrides.update_id ?? Math.floor(Math.random() * 1_000_000_000),
      message: {
        message_id: 1, date: 1700000000,
        from: { id: 388621843 }, chat: { id: 388621843 },
        ...(text !== undefined ? { text } : {}),
      },
      ...overrides,
    };
  }

  // 1. secret mismatch → 401
  it("(1) secret mismatch → 401", async () => {
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "WRONG").send(makeUpdate());
    expect(r.status).toBe(401);
  });

  // 2. malformed payload → 200 + dropped:malformed
  it("(2) malformed payload → 200 'malformed'", async () => {
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send({ junk: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dropped: "malformed" });
  });

  // 3. wrong chat_id → 200 dropped:rejected_chat_id
  it("(3) chat_id mismatch → 200 'rejected_chat_id'", async () => {
    const u = makeUpdate("hi");
    u.message.chat.id = 99999; // not BOSS
    u.message.from.id = 99999;
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(u);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dropped: "rejected_chat_id" });
  });

  // 4. duplicate update_id → 200 + duplicate:true, no triggerAgentResponses
  it("(4) duplicate update_id → ON CONFLICT no-op, no dispatch", async () => {
    dbState.insertReturning = []; // simulate conflict
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("hi"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ duplicate: true });
    expect(triggerAgentResponsesMock).not.toHaveBeenCalled();
    expect(sendTelegramMock).not.toHaveBeenCalled();
  });

  // 5. 11th message in 60s → 200 dropped:rate_limit
  it("(5) 11th message in 60s → rate_limit drop", async () => {
    const chatId = 388621843;
    // Pre-fill the in-memory bucket to exactly 10
    for (let i = 0; i < 10; i++) checkInboundRateLimit(chatId);
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("11th"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dropped: "rate_limit" });
    expect(triggerAgentResponsesMock).not.toHaveBeenCalled();
  });

  // 6. text → addRoomMessage + broadcast + triggerAgentResponses("Partner")
  it("(6) free-form text → partner-room dispatch", async () => {
    vi.mocked(storage.getRooms).mockResolvedValue([
      { id: 77, name: "Partner", purpose: "user", agentIds: "[42]" } as any,
    ]);
    vi.mocked(storage.addRoomMessage).mockResolvedValue({ id: 1001 } as any);

    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("привет"));

    expect(r.status).toBe(200);
    expect(storage.addRoomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 77, content: "привет", agentName: expect.stringContaining("BOSS") }),
      BOSS_USER_ID,
    );
    expect(broadcastToRoomMock).toHaveBeenCalledWith(77, expect.any(Object));
    expect(triggerAgentResponsesMock).toHaveBeenCalledWith(77, BOSS_USER_ID, null, "BOSS", "привет", [42], "Partner");
  });

  // 7. partner-room not found → 503 + outbound "Лука не настроен"
  it("(7) no partner room → 503 + outbound 'не настроен'", async () => {
    vi.mocked(storage.getRooms).mockResolvedValue([]);
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("hi"));
    expect(r.status).toBe(503);
    expect(sendTelegramMock).toHaveBeenCalledWith(expect.objectContaining({
      reason: "partner_room_not_found",
      text: expect.stringContaining("не настроен"),
    }));
  });

  // 8. /status → outbound contains status fields + commit
  it("(8) /status → outbound carries status + commit", async () => {
    process.env.PUBLIC_URL = "http://localhost:5000";
    process.env.INTERNAL_HEALTH_SECRET = "ihs";
    process.env.RAILWAY_GIT_COMMIT_SHA = "0123456789ab";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ status: "ok", db: "up", uptime_sec: 60, last_check: { ok: true, blocking_drift_count: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("/status"));

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ command: "status" });
    expect(sendTelegramMock).toHaveBeenCalledWith(expect.objectContaining({
      reason: "command:status", urgency: "high",
      text: expect.stringMatching(/Статус: ok/),
    }));
    const callArg = sendTelegramMock.mock.calls[0][0];
    expect(callArg.text).toMatch(/0123456/);
    fetchSpy.mockRestore();
  });

  // 9. /queue empty
  it("(9) /queue empty → outbound 'Очередь пуста'", async () => {
    vi.mocked(storage.getScheduledTasks).mockResolvedValue([]);
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("/queue"));
    expect(r.status).toBe(200);
    expect(sendTelegramMock).toHaveBeenCalledWith(expect.objectContaining({
      text: "Очередь пуста.", reason: "command:queue",
    }));
  });

  // 10. /queue with tasks → list
  it("(10) /queue with tasks → list", async () => {
    vi.mocked(storage.getScheduledTasks).mockResolvedValue([
      { id: 1, status: "active", title: "Daily" }, { id: 2, status: "pending", title: "OneOff" },
    ]);
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("/queue"));
    expect(r.status).toBe(200);
    const out = sendTelegramMock.mock.calls[0][0].text as string;
    expect(out).toMatch(/#1.*active.*Daily/);
    expect(out).toMatch(/#2.*pending.*OneOff/);
  });

  // 11. /cancel valid
  it("(11) /cancel <id> valid → 'отменена'", async () => {
    vi.mocked(storage.updateScheduledTask).mockResolvedValue({ id: 5, status: "cancelled" });
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("/cancel 5"));
    expect(r.status).toBe(200);
    expect(storage.updateScheduledTask).toHaveBeenCalledWith(5, BOSS_USER_ID, { status: "cancelled" });
    expect(sendTelegramMock).toHaveBeenCalledWith(expect.objectContaining({
      text: "Задача #5 отменена.",
    }));
  });

  // 12. /cancel invalid
  it("(12) /cancel <id> not-found → 'не найдена'", async () => {
    vi.mocked(storage.updateScheduledTask).mockResolvedValue(undefined);
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("/cancel 999"));
    expect(r.status).toBe(200);
    expect(sendTelegramMock).toHaveBeenCalledWith(expect.objectContaining({
      text: "Задача #999 не найдена.",
    }));
  });

  // 13. /help → list
  it("(13) /help → outbound includes /status, /queue, /cancel", async () => {
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("/help"));
    expect(r.status).toBe(200);
    const out = sendTelegramMock.mock.calls[0][0].text as string;
    expect(out).toMatch(/\/status/);
    expect(out).toMatch(/\/queue/);
    expect(out).toMatch(/\/cancel/);
  });

  // 14. unknown command
  it("(14) unknown /foo → 'Неизвестная команда'", async () => {
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("/foobar"));
    expect(r.status).toBe(200);
    expect(sendTelegramMock).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/Неизвестная команда/),
    }));
  });

  // 15. non-text (no `text`) → "только текст"
  it("(15) non-text payload → 'только текст'", async () => {
    const u = {
      update_id: 42,
      message: { message_id: 1, from: { id: 388621843 }, chat: { id: 388621843 }
        /* deliberately omit text — Telegram does this for photo/voice/sticker */ },
    };
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(u);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dropped: "non_text" });
    expect(sendTelegramMock).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/только текст/),
    }));
  });

  // 16. text > 4096 → truncate
  it("(16) text > 4096 chars → truncated to 4096 in addRoomMessage", async () => {
    vi.mocked(storage.getRooms).mockResolvedValue([
      { id: 77, name: "Partner", purpose: "user", agentIds: "[42]" } as any,
    ]);
    vi.mocked(storage.addRoomMessage).mockResolvedValue({ id: 1 } as any);
    const long = "x".repeat(5000);
    const r = await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate(long));
    expect(r.status).toBe(200);
    const arg = vi.mocked(storage.addRoomMessage).mock.calls[0][0] as any;
    expect(arg.content.length).toBe(4096);
  });

  // 17. broadcastTelegramInboundEvent fired correctly
  it("(17) ws broadcastTelegramInboundEvent fires for both message and command", async () => {
    vi.mocked(storage.getRooms).mockResolvedValue([
      { id: 77, name: "Partner", purpose: "user", agentIds: "[42]" } as any,
    ]);
    vi.mocked(storage.addRoomMessage).mockResolvedValue({ id: 1 } as any);

    // free-form message
    await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("hello"));
    expect(broadcastTelegramInboundEventMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: BOSS_USER_ID, kind: "message", text: "hello",
    }));

    // command
    broadcastTelegramInboundEventMock.mockClear();
    await request(app).post("/api/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "test-webhook-secret").send(makeUpdate("/help"));
    expect(broadcastTelegramInboundEventMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: BOSS_USER_ID, kind: "command", command: "help",
    }));
  });
});
