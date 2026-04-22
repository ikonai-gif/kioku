/**
 * Tests for Meeting WS subscription + event bus (W9 Item 3-4).
 *
 * Uses a real WebSocket server on an ephemeral port. Auth is via the
 * dev-secret JWT cookie (same path exercised in production). Covers:
 *  - subscribe accepted for creator and active-participant-owner
 *  - subscribe rejected for non-participant (scope ACL)
 *  - event payload metadata-only (F1 — no content/contentPreview)
 *  - rate limit drops >2 events/sec per meeting
 *  - disconnect cleans up meetingClients
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import http from "http";
import { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import WebSocket from "ws";

// Mock pg BEFORE importing ws.ts.
class WsFakePg {
  allowedMeetings = new Map<string, Set<number>>(); // meetingId → userIds who can access

  async query(sql: string, params?: any[]) {
    if (/FROM\s+meetings\s+m\s+WHERE\s+m\.id\s*=\s*\$1/i.test(sql)) {
      const [mid, uid] = params!;
      const allowed = this.allowedMeetings.get(mid)?.has(uid) ?? false;
      return { rows: allowed ? [{ "?column?": 1 }] : [], rowCount: allowed ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}
const holder = vi.hoisted(() => ({ fake: null as any }));
vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = (...a: any[]) => holder.fake.query(...a);
    this.connect = () => Promise.resolve({ query: (...a: any[]) => holder.fake.query(...a), release: () => {} });
    this.on = () => {};
    this.end = () => Promise.resolve();
  }
  return { Pool: MockPool };
});
holder.fake = new WsFakePg();
const fake = holder.fake as WsFakePg;
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => ({}) }));
// Short-circuit storage.getRoom so room-subscribe path doesn't hit drizzle.
vi.mock("../storage", async () => ({
  pool: new (await import("pg")).Pool(),
  storage: { getRoom: async () => null, getUserByApiKey: async () => null },
}));

import {
  setupWebSocket,
  WsMeetingEventBus,
  _resetMeetingWsStateForTests,
  _getMeetingSubscriberCountForTests,
} from "../ws";

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret";

async function makeWsServer() {
  const server = http.createServer();
  setupWebSocket(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

function connect(port: number, userId: number): Promise<WebSocket> {
  const token = jwt.sign({ userId }, JWT_SECRET, { algorithm: "HS256" });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 500): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("waitForMessage timeout")), timeoutMs);
    const onMsg = (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (predicate(parsed)) {
          clearTimeout(t);
          ws.off("message", onMsg);
          resolve(parsed);
        }
      } catch {
        /* ignore */
      }
    };
    ws.on("message", onMsg);
  });
}

describe("Meeting WS subscribe + event bus", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    _resetMeetingWsStateForTests();
    fake.allowedMeetings.clear();
    ({ server, port } = await makeWsServer());
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("accepts subscribe for authorised user", async () => {
    const mid = randomUUID();
    fake.allowedMeetings.set(mid, new Set([1]));
    const ws = await connect(port, 1);
    ws.send(JSON.stringify({ type: "subscribe", topic: "meeting", meetingId: mid }));
    const msg = await waitForMessage(ws, (m) => m.type === "subscribed" && m.topic === "meeting");
    expect(msg).toEqual({ type: "subscribed", topic: "meeting", meetingId: mid });
    expect(_getMeetingSubscriberCountForTests(mid)).toBe(1);
    ws.close();
  });

  it("rejects subscribe for unauthorised user (scope ACL)", async () => {
    const mid = randomUUID();
    fake.allowedMeetings.set(mid, new Set([1])); // user 2 NOT in allow-list
    const ws = await connect(port, 2);
    ws.send(JSON.stringify({ type: "subscribe", topic: "meeting", meetingId: mid }));
    const msg = await waitForMessage(ws, (m) => m.type === "error" && m.topic === "meeting");
    expect(msg.message).toBe("Meeting not found");
    expect(_getMeetingSubscriberCountForTests(mid)).toBe(0);
    ws.close();
  });

  it("F1: event payload contains NO content or contentPreview", async () => {
    const mid = randomUUID();
    fake.allowedMeetings.set(mid, new Set([1]));
    const ws = await connect(port, 1);
    ws.send(JSON.stringify({ type: "subscribe", topic: "meeting", meetingId: mid }));
    await waitForMessage(ws, (m) => m.type === "subscribed");

    const bus = new WsMeetingEventBus();
    await bus.emit("meeting.turn.completed", {
      meetingId: mid,
      participantId: "p1",
      agentId: 100,
      sequenceNumber: 5,
      visibility: "all",
    });

    const evt = await waitForMessage(ws, (m) => m.type === "meeting_event");
    expect(evt.event).toBe("meeting.turn.completed");
    expect(evt.meetingId).toBe(mid);
    expect(evt.sequenceNumber).toBe(5);
    expect(evt.content).toBeUndefined();
    expect(evt.contentPreview).toBeUndefined();
    ws.close();
  });

  it("delivers events only to subscribers of the correct meeting (no scope leak)", async () => {
    const mid1 = randomUUID();
    const mid2 = randomUUID();
    fake.allowedMeetings.set(mid1, new Set([1]));
    fake.allowedMeetings.set(mid2, new Set([2]));

    const ws1 = await connect(port, 1);
    const ws2 = await connect(port, 2);
    ws1.send(JSON.stringify({ type: "subscribe", topic: "meeting", meetingId: mid1 }));
    ws2.send(JSON.stringify({ type: "subscribe", topic: "meeting", meetingId: mid2 }));
    await waitForMessage(ws1, (m) => m.type === "subscribed");
    await waitForMessage(ws2, (m) => m.type === "subscribed");

    const bus = new WsMeetingEventBus();
    await bus.emit("meeting.state.changed", { meetingId: mid1, state: "completed" });

    // ws1 should receive, ws2 should NOT within a short window.
    const ws1Msg = await waitForMessage(ws1, (m) => m.type === "meeting_event");
    expect(ws1Msg.meetingId).toBe(mid1);

    let ws2LeakedMid1 = false;
    const onWs2 = (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "meeting_event" && m.meetingId === mid1) ws2LeakedMid1 = true;
    };
    ws2.on("message", onWs2);
    await new Promise((r) => setTimeout(r, 60));
    expect(ws2LeakedMid1).toBe(false);
    ws2.off("message", onWs2);

    ws1.close();
    ws2.close();
  });

  it("throttle: drops emissions exceeding 2/sec per meeting", async () => {
    const mid = randomUUID();
    fake.allowedMeetings.set(mid, new Set([1]));
    const ws = await connect(port, 1);
    ws.send(JSON.stringify({ type: "subscribe", topic: "meeting", meetingId: mid }));
    await waitForMessage(ws, (m) => m.type === "subscribed");

    const received: any[] = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "meeting_event") received.push(m);
    });

    const bus = new WsMeetingEventBus();
    for (let i = 0; i < 5; i++) {
      await bus.emit("meeting.state.changed", { meetingId: mid, state: "active", reason: `n${i}` });
    }

    await new Promise((r) => setTimeout(r, 50));
    // Rate limit = 2/sec. First 2 pass, remaining 3 dropped.
    expect(received.length).toBe(2);
    ws.close();
  });

  it("disconnect cleans up meetingClients subscription", async () => {
    const mid = randomUUID();
    fake.allowedMeetings.set(mid, new Set([1]));
    const ws = await connect(port, 1);
    ws.send(JSON.stringify({ type: "subscribe", topic: "meeting", meetingId: mid }));
    await waitForMessage(ws, (m) => m.type === "subscribed");
    expect(_getMeetingSubscriberCountForTests(mid)).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 40));
    expect(_getMeetingSubscriberCountForTests(mid)).toBe(0);
  });

  it("explicit unsubscribe removes sub without closing ws", async () => {
    const mid = randomUUID();
    fake.allowedMeetings.set(mid, new Set([1]));
    const ws = await connect(port, 1);
    ws.send(JSON.stringify({ type: "subscribe", topic: "meeting", meetingId: mid }));
    await waitForMessage(ws, (m) => m.type === "subscribed");
    ws.send(JSON.stringify({ type: "unsubscribe", topic: "meeting", meetingId: mid }));
    await waitForMessage(ws, (m) => m.type === "unsubscribed" && m.meetingId === mid);
    expect(_getMeetingSubscriberCountForTests(mid)).toBe(0);
    ws.close();
  });

  it("unauthorised connection closes with 4001", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => {
      ws.once("close", (code) => {
        expect(code).toBe(4001);
        resolve();
      });
    });
  });
});
