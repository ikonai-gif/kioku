import { WebSocketServer, WebSocket } from "ws";
import { type Server } from "http";

// Room subscriptions: roomId → Set of WebSocket clients
const roomClients = new Map<number, Set<WebSocket>>();

export function setupWebSocket(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    let subscribedRoom: number | null = null;

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Client subscribes to a room
        if (msg.type === "subscribe" && typeof msg.roomId === "number") {
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
