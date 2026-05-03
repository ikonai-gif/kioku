import { WebSocketServer, WebSocket } from "ws";
import { type Server } from "http";
import jwt from "jsonwebtoken";
import { storage, pool } from "./storage";
import { verifyMeetingAccess } from "./lib/meeting-acl";
import type {
  MeetingEventBus,
  MeetingEventName,
  MeetingEventPayload,
} from "./lib/meeting-event-bus";
import logger from "./logger";
// @ts-ignore — cookie has no bundled types
import cookie from "cookie";

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret');

// Room subscriptions: roomId → Set of WebSocket clients
const roomClients = new Map<number, Set<WebSocket>>();

// Meeting topic subscriptions (W9 Item 3-4): meetingId (uuid) → Set<WebSocket>.
// Separate namespace from `roomClients` (which is keyed by numeric roomId) so
// WS clients can be subscribed to both a partner-chat room AND a meeting.
const meetingClients = new Map<string, Set<WebSocket>>();

// Per-meeting send throttle (W9 Item 3-4): max 2 events/sec/meeting. We keep
// a rolling window of recent send timestamps and drop emissions that exceed
// the cap — the meeting_context rows are durable, so a dropped event is a UX
// miss, not a correctness bug. Kept in-memory; reset on process restart.
const MEETING_EVENT_RATE_LIMIT = 2; // per second per meetingId
const meetingEmitHistory = new Map<string, number[]>();

// Per-user subscriptions (Day 6 — Luca approval gate events). Used by
// `broadcastToUser` to push events that aren't scoped to any specific room:
//   - luca.approval.requested
//   - luca.approval.decided
// The Luca Board UI subscribes once per connection via
//   { type: "subscribe", topic: "user" }
// No ACL check beyond JWT auth — a user can only ever subscribe to their
// own events because subscribe uses the authenticated userId directly.
const userClients = new Map<number, Set<WebSocket>>();

// Track authenticated userId per WebSocket
const wsUserMap = new WeakMap<WebSocket, number>();

// Module-level wss reference for graceful shutdown
let _wss: WebSocketServer | null = null;
export function getWss(): WebSocketServer | null { return _wss; }

function authenticateWs(req: any): number | null {
  // Try x-api-key header
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
  if (apiKeyHeader && apiKeyHeader.startsWith("kk_")) {
    // API key auth is async — handled below
    return null; // will be handled via async path
  }

  // Try JWT from cookie
  const cookies = cookie.parse(req.headers.cookie || "");
  const cookieToken = cookies["kioku_session"];
  if (cookieToken) {
    try {
      const payload = jwt.verify(cookieToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: number };
      return payload.userId ?? null;
    } catch { /* fall through */ }
  }

  // Try x-session-token header
  const sessionToken = req.headers["x-session-token"] as string | undefined;
  if (sessionToken) {
    try {
      const payload = jwt.verify(sessionToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: number };
      return payload.userId ?? null;
    } catch { /* fall through */ }
  }

  // Try token from query string
  const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    try {
      const payload = jwt.verify(queryToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: number };
      return payload.userId ?? null;
    } catch { /* fall through */ }
  }

  return null;
}

async function authenticateWsAsync(req: any): Promise<number | null> {
  // Try synchronous methods first
  const syncResult = authenticateWs(req);
  if (syncResult !== null) return syncResult;

  // Try API key (async)
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
  if (apiKeyHeader && apiKeyHeader.startsWith("kk_")) {
    try {
      const user = await storage.getUserByApiKey(apiKeyHeader);
      return user ? user.id : null;
    } catch { return null; }
  }

  return null;
}

export function setupWebSocket(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  _wss = wss;

  wss.on("connection", async (ws, req) => {
    // Authenticate on connection
    const userId = await authenticateWsAsync(req);
    if (userId === null) {
      ws.close(4001, "Unauthorized");
      return;
    }
    wsUserMap.set(ws, userId);

    let subscribedRoom: number | null = null;
    // Multiple meeting subscriptions allowed per WS connection (UI can open
    // more than one meeting tab on the same socket). Set also tolerates a
    // client spamming subscribe for the same meetingId (idempotent Set.add).
    const subscribedMeetings = new Set<string>();
    // Day 6: flag so cleanup can drop this ws from userClients on close.
    let subscribedToUser = false;

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Client subscribes to a room (partner chat — numeric id)
        if (msg.type === "subscribe" && typeof msg.roomId === "number") {
          // Verify room belongs to authenticated user
          const room = await storage.getRoom(msg.roomId, userId);
          if (!room) {
            ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
            return;
          }

          // Unsubscribe from previous room
          if (subscribedRoom !== null) {
            roomClients.get(subscribedRoom)?.delete(ws);
          }
          subscribedRoom = msg.roomId as number;
          const rid = subscribedRoom;
          if (!roomClients.has(rid)) {
            roomClients.set(rid, new Set());
          }
          roomClients.get(rid)!.add(ws);
          ws.send(JSON.stringify({ type: "subscribed", roomId: rid }));
          return;
        }

        // Client subscribes to a meeting topic (W9 Item 3-4 — uuid id)
        if (
          msg.type === "subscribe" &&
          msg.topic === "meeting" &&
          typeof msg.meetingId === "string"
        ) {
          // ACL: re-use verifyMeetingAccess. No recovery if DB is down — we
          // reply with an error and the client retries.
          let allowed = false;
          try {
            allowed = await verifyMeetingAccess(pool, userId, msg.meetingId);
          } catch (err) {
            logger.warn(
              { err: (err as Error).message, meetingId: msg.meetingId, userId },
              "[ws] meeting subscribe ACL check failed",
            );
          }
          if (!allowed) {
            ws.send(
              JSON.stringify({
                type: "error",
                topic: "meeting",
                meetingId: msg.meetingId,
                message: "Meeting not found",
              }),
            );
            return;
          }
          const mid = msg.meetingId;
          if (!meetingClients.has(mid)) meetingClients.set(mid, new Set());
          meetingClients.get(mid)!.add(ws);
          subscribedMeetings.add(mid);
          ws.send(JSON.stringify({ type: "subscribed", topic: "meeting", meetingId: mid }));
          return;
        }

        // Explicit unsubscribe from a meeting topic
        if (
          msg.type === "unsubscribe" &&
          msg.topic === "meeting" &&
          typeof msg.meetingId === "string"
        ) {
          meetingClients.get(msg.meetingId)?.delete(ws);
          subscribedMeetings.delete(msg.meetingId);
          ws.send(
            JSON.stringify({ type: "unsubscribed", topic: "meeting", meetingId: msg.meetingId }),
          );
          return;
        }

        // Day 6: per-user subscription for Luca approval events.
        // Idempotent — clients may subscribe multiple times (tab focus etc.)
        if (msg.type === "subscribe" && msg.topic === "user") {
          if (!userClients.has(userId)) userClients.set(userId, new Set());
          userClients.get(userId)!.add(ws);
          subscribedToUser = true;
          ws.send(JSON.stringify({ type: "subscribed", topic: "user", userId }));
          return;
        }

        if (msg.type === "unsubscribe" && msg.topic === "user") {
          userClients.get(userId)?.delete(ws);
          subscribedToUser = false;
          ws.send(JSON.stringify({ type: "unsubscribed", topic: "user", userId }));
          return;
        }
      } catch {
        // ignore invalid messages
      }
    });

    const cleanup = () => {
      if (subscribedRoom !== null) {
        roomClients.get(subscribedRoom)?.delete(ws);
      }
      for (const mid of subscribedMeetings) {
        meetingClients.get(mid)?.delete(ws);
      }
      subscribedMeetings.clear();
      if (subscribedToUser) {
        userClients.get(userId)?.delete(ws);
        subscribedToUser = false;
      }
    };

    ws.on("close", cleanup);

    ws.on("error", cleanup);
  });

  return wss;
}

/** Get total active WebSocket connections across all rooms. */
export function getActiveWsConnectionCount(): number {
  let total = 0;
  for (const clients of roomClients.values()) {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) total++;
    }
  }
  return total;
}

/**
 * Day 6 — broadcast to every open ws subscribed to a given user's topic.
 * Used by Luca approval gate events that aren't room-scoped (Luca Board
 * UI listens regardless of which partner-chat room is focused).
 *
 * Best-effort: silently returns if no one is subscribed. Clients re-fetch
 * via REST on reconnect.
 */
export function broadcastToUser(userId: number, payload: Record<string, unknown>): void {
  const clients = userClients.get(userId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(payload);
  Array.from(clients).forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch { /* best-effort */ }
    }
  });
}

/** Test-only: drop all user subscriptions (for vitest cleanup). */
export function __clearUserClientsForTests(): void {
  userClients.clear();
}

/**
 * Discriminated union of WS broadcast payloads accepted by
 * `broadcastToRoom`. `GenericBroadcast` intentionally keeps the door open
 * for storage-row passthrough (e.g. `if (msg) broadcastToRoom(roomId, msg)`
 * in scheduler/deliberation) — the union is a type-safety floor, not a
 * wall: known payloads get structural checks, unknown ones still compile.
 *
 * When the default `{ type: "message" }` shape is intended, set `type`
 * explicitly here instead of relying on the spread default — the default
 * remains for backwards-compat only.
 */
export type DegradedAgentNoticeBroadcast = {
  type: "degraded_agent_notice";
  agentId: number;
  agentName: string;
  degraded: boolean;
  retryAfterMs: number;
};

export type NewMessageBroadcast = {
  type: "new_message";
  message: {
    roomId: number;
    agentId: number;
    agentName: string;
    agentColor: string;
    content: string;
    createdAt: number;
  };
};

export type EmailConfirmRequiredBroadcast = {
  type: "email_confirm_required";
  token: string;
  expiresAt: number;
  preview: Record<string, unknown>;
};

export type GenericBroadcast = {
  type?: string;
  [key: string]: unknown;
};

export type WsBroadcast =
  | DegradedAgentNoticeBroadcast
  | NewMessageBroadcast
  | EmailConfirmRequiredBroadcast
  | GenericBroadcast;

/**
 * Broadcast a new message to all clients subscribed to a room.
 * Called from routes.ts when a message is POSTed.
 */
export function broadcastToRoom(roomId: number, payload: WsBroadcast) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const data = JSON.stringify({ type: "message", ...payload });
  Array.from(clients).forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

/**
 * Broadcast a streaming text chunk to all clients in a room.
 * Used by Partner Chat to display Agent O's response word-by-word.
 */
export function broadcastStreamChunk(roomId: number, payload: {
  messageId?: number;
  agentId: number;
  agentName: string;
  agentColor: string;
  chunk: string;
  done: boolean;
}) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const data = JSON.stringify({ type: "stream_chunk", ...payload });
  Array.from(clients).forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

/**
 * Broadcast a tool activity event (start / done / error) to all clients in a room.
 * Used to give the user a live "what is the agent doing right now" timeline,
 * similar to how larger agent UIs stream their tool calls in real time.
 *
 * This is best-effort — if the broadcast fails or no one is subscribed, the
 * agent's actual work is unaffected.
 */
export function broadcastToolActivity(roomId: number, payload: {
  agentId: number;
  agentName?: string;
  tool: string;
  /**
   * 'running' | 'done' | 'error' are lifecycle events.
   * 'chunk' carries a raw stdout/stderr slice from a still-running tool
   * so the UI can render a live console log under the step.
   */
  status: "running" | "done" | "error" | "chunk";
  description?: string;
  elapsedMs?: number;
  preview?: string;
  error?: string;
  /** For status=chunk only: a raw fragment of output. */
  chunk?: string;
  /** For status=chunk only: which stream the fragment came from. */
  stream?: "stdout" | "stderr";
  /** Step identity — lets the UI attach chunks to the correct step even if several of the same tool run concurrently. */
  stepId?: string;
  /**
   * Phase 2 (R-luca-computer-ui): media (e.g. screenshots) attached to a
   * 'done' status — lets the UI render inline thumbnails the moment the tool
   * finishes, instead of waiting for the next /tool-activity poll.
   * Each entry mirrors the JSONB row format in tool_activity_log.media_urls.
   */
  mediaUrls?: Array<{
    storage_key: string;
    signed_url: string;
    signed_expires_at: number;
    content_type: string;
    kind: "screenshot" | "file" | "video";
    source_url?: string | null;
    /** Phase 3 (R-luca-computer-ui): size for FileLightbox PDF gate. */
    size_bytes?: number;
  }>;
  timestamp: number;
}) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const data = JSON.stringify({ type: "tool_activity", ...payload });
  Array.from(clients).forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch { /* best-effort */ }
    }
  });
}

/**
 * Broadcast a human_turn event to all clients subscribed to a room.
 * Signals that it's the human participant's turn to respond in a deliberation.
 */
export function broadcastHumanTurn(roomId: number, payload: {
  sessionId: string;
  phase: string;
  round: number;
  topic: string;
  priorPositions: Array<{ agentName: string; position: string; confidence: number; reasoning: string }>;
  timeoutMs: number;
}) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const data = JSON.stringify({ type: "human_turn", ...payload });
  Array.from(clients).forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ── Meeting Room event bus (W9 Item 3-4) ────────────────────────────────────

/**
 * Per-meeting rate limiter. Keeps a rolling 1-second window of send timestamps
 * per meetingId; if the window already contains `MEETING_EVENT_RATE_LIMIT`
 * entries, the emission is dropped. The history array is compacted on each
 * call so memory per meeting is O(limit).
 */
function shouldEmitMeetingEvent(meetingId: string, nowMs: number): boolean {
  const cutoff = nowMs - 1000;
  const history = meetingEmitHistory.get(meetingId) ?? [];
  // Drop entries older than the window.
  let i = 0;
  while (i < history.length && history[i] < cutoff) i++;
  const fresh = i === 0 ? history : history.slice(i);
  if (fresh.length >= MEETING_EVENT_RATE_LIMIT) {
    // Write back compacted history even on drop so we don't accumulate stale
    // entries forever if emissions burst then die off.
    meetingEmitHistory.set(meetingId, fresh);
    return false;
  }
  fresh.push(nowMs);
  meetingEmitHistory.set(meetingId, fresh);
  return true;
}

/**
 * Broadcast a meeting event to all WS clients subscribed to this meeting's
 * topic. Metadata-only (F1) — no `content` or `contentPreview` fields, full
 * stop. Subscribers fetch bodies via GET /api/meetings/:id/context which
 * re-applies visibility ACL per-viewer.
 */
function broadcastToMeeting(
  meetingId: string,
  event: MeetingEventName,
  payload: MeetingEventPayload,
): number {
  const clients = meetingClients.get(meetingId);
  if (!clients || clients.size === 0) return 0;
  if (!shouldEmitMeetingEvent(meetingId, Date.now())) {
    logger.debug(
      { meetingId, event, dropped: true },
      "[ws] meeting event dropped (rate-limited)",
    );
    return 0;
  }
  // Assemble the wire payload. We spread `payload` last so a future
  // additional metadata field shows up automatically — but F1 is enforced
  // structurally: MeetingEventPayload has no content/contentPreview.
  const data = JSON.stringify({ type: "meeting_event", event, ...payload });
  let delivered = 0;
  for (const client of Array.from(clients)) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
        delivered++;
      } catch {
        /* best-effort */
      }
    }
  }
  return delivered;
}

/**
 * Production MeetingEventBus. Fire-and-forget; always resolves — emission
 * errors are logged, not raised, so the turn runner's durable commit is
 * never rolled back by a WS hiccup.
 */
export class WsMeetingEventBus implements MeetingEventBus {
  async emit(event: MeetingEventName, payload: MeetingEventPayload): Promise<void> {
    try {
      broadcastToMeeting(payload.meetingId, event, payload);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, event, meetingId: payload.meetingId },
        "[ws] WsMeetingEventBus emit failed (swallowed)",
      );
    }
  }
}

/** Test helpers — NOT exported to app code. */
export function _resetMeetingWsStateForTests(): void {
  for (const set of meetingClients.values()) set.clear();
  meetingClients.clear();
  meetingEmitHistory.clear();
}

export function _getMeetingSubscriberCountForTests(meetingId: string): number {
  return meetingClients.get(meetingId)?.size ?? 0;
}
