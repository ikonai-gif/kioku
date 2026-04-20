import { WebSocketServer, WebSocket } from "ws";
import { type Server } from "http";
import jwt from "jsonwebtoken";
import { storage } from "./storage";
// @ts-ignore — cookie has no bundled types
import cookie from "cookie";

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret');

// Room subscriptions: roomId → Set of WebSocket clients
const roomClients = new Map<number, Set<WebSocket>>();

// Track authenticated userId per WebSocket
const wsUserMap = new WeakMap<WebSocket, number>();

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

  wss.on("connection", async (ws, req) => {
    // Authenticate on connection
    const userId = await authenticateWsAsync(req);
    if (userId === null) {
      ws.close(4001, "Unauthorized");
      return;
    }
    wsUserMap.set(ws, userId);

    let subscribedRoom: number | null = null;

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Client subscribes to a room
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
        }
      } catch {
        // ignore invalid messages
      }
    });

    ws.on("close", () => {
      if (subscribedRoom !== null) {
        roomClients.get(subscribedRoom)?.delete(ws);
      }
    });

    ws.on("error", () => {
      if (subscribedRoom !== null) {
        roomClients.get(subscribedRoom)?.delete(ws);
      }
    });
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
 * Broadcast a new message to all clients subscribed to a room.
 * Called from routes.ts when a message is POSTed.
 */
export function broadcastToRoom(roomId: number, payload: object) {
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
