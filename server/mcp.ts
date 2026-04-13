/**
 * KIOKU™ MCP Server endpoint — Phase 2C
 * Implements Model Context Protocol (MCP) over HTTP/SSE
 * Compatible with: Claude Desktop, Cursor, Continue, Cline
 *
 * Connection: POST /mcp  (JSON-RPC 2.0)
 * Auth: x-api-key header or ?api_key= query param
 *
 * Supported tools:
 *   - kioku_store_memory   — store a memory for an agent
 *   - kioku_search_memory  — semantic search memories
 *   - kioku_list_agents    — list all agents
 *   - kioku_list_memories  — list all memories (paginated)
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { embedText } from "./embeddings";
import { safeCompare } from "./index";

// MCP tool argument validation schemas
const mcpStoreMemorySchema = z.object({
  content: z.string().min(1).max(50000),
  type: z.enum(["semantic", "episodic", "procedural", "emotional"]).optional(),
  importance: z.number().min(0).max(1).optional(),
  namespace: z.string().max(100).optional(),
  agentName: z.string().max(100).optional(),
});

const mcpSearchMemorySchema = z.object({
  query: z.string().min(1).max(1000),
  namespace: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const mcpListMemoriesSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  namespace: z.string().max(100).optional(),
});

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// MCP tool definitions (returned in tools/list)
const MCP_TOOLS = [
  {
    name: "kioku_store_memory",
    description:
      "Store a memory in KIOKU™ for an agent. Use this to persist knowledge, decisions, preferences, or context that the agent should remember across sessions.",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string", description: "The memory content to store" },
        agentName: { type: "string", description: "Name of the agent (defaults to 'MCP Agent')" },
        type: {
          type: "string",
          enum: ["semantic", "episodic", "procedural"],
          description: "Memory type. semantic=facts, episodic=events, procedural=how-to",
        },
        importance: {
          type: "number",
          description: "Importance score 0.0–1.0 (default 0.7)",
          minimum: 0,
          maximum: 1,
        },
        namespace: {
          type: "string",
          description: "Namespace for AUDN isolation (default: 'default')",
        },
      },
    },
  },
  {
    name: "kioku_search_memory",
    description:
      "Search KIOKU™ memories using semantic similarity. Returns the most relevant memories for the given query.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Natural language search query" },
        namespace: {
          type: "string",
          description: "Filter by namespace (optional)",
        },
      },
    },
  },
  {
    name: "kioku_list_agents",
    description: "List all agents registered in KIOKU™.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kioku_list_memories",
    description: "List recent memories from KIOKU™ (up to 50).",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Filter by namespace" },
      },
    },
  },
];

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcErr(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function resolveUserId(req: Request): Promise<number | null> {
  const key =
    (req.headers["x-api-key"] as string) ||
    (req.query.api_key as string) ||
    (req.headers["x-session-token"] as string);
  if (!key) return null;
  // Master key from env
  const masterKey = process.env.KIOKU_MASTER_KEY;
  if (masterKey && safeCompare(key, masterKey)) return 1;
  // lookup by API key
  const user = await storage.getUserByApiKey(key);
  return user?.id ?? null;
}

export function registerMcp(app: Express) {
  // ── MCP manifest (GET /mcp) ───────────────────────────────────────────
  app.get("/mcp", (_req, res) => {
    res.json({
      name: "KIOKU™ Memory",
      version: "0.1.0",
      description: "Agent Memory & Deliberation by IKONBAI™",
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
      },
    });
  });

  // ── MCP JSON-RPC handler (POST /mcp) ──────────────────────────────────
  app.post("/mcp", async (req: Request, res: Response) => {
    const body = req.body as JsonRpcRequest;

    if (!body || body.jsonrpc !== "2.0") {
      return res.status(400).json(rpcErr(null, -32600, "Invalid JSON-RPC request"));
    }

    const { id, method, params = {} } = body;

    // ── initialize ────────────────────────────────────────────────────
    if (method === "initialize") {
      return res.json(
        ok(id, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "KIOKU™ Memory", version: "0.1.0" },
          capabilities: { tools: { listChanged: false } },
        })
      );
    }

    // ── tools/list ────────────────────────────────────────────────────
    if (method === "tools/list") {
      return res.json(ok(id, { tools: MCP_TOOLS }));
    }

    // ── tools/call ────────────────────────────────────────────────────
    if (method === "tools/call") {
      const userId = await resolveUserId(req);
      if (!userId) {
        return res.json(rpcErr(id, -32001, "Unauthorized — provide x-api-key header"));
      }

      const toolName = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      try {
        let content: string;

        switch (toolName) {
          case "kioku_store_memory": {
            const validatedArgs = mcpStoreMemorySchema.parse(args);
            const mem = await storage.createMemory({
              userId,
              agentId: null,
              agentName: validatedArgs.agentName ?? "MCP Agent",
              content: validatedArgs.content,
              type: validatedArgs.type ?? "semantic",
              importance: validatedArgs.importance ?? 0.7,
              namespace: validatedArgs.namespace ?? "default",
              embedding: await embedText(validatedArgs.content).then(
                (v) => (v ? JSON.stringify(v) : null)
              ),
            });
            content = `Memory stored (id: ${mem.id})`;
            break;
          }

          case "kioku_search_memory": {
            const validatedArgs = mcpSearchMemorySchema.parse(args);
            const embedding = await embedText(validatedArgs.query);
            const results = await storage.searchMemories(userId, validatedArgs.query, embedding ?? undefined);
            const filtered = validatedArgs.namespace
              ? results.filter((m) => m.namespace === validatedArgs.namespace)
              : results;
            content = filtered.length === 0
              ? "No memories found."
              : filtered
                  .map((m) => `[${m.namespace}] (${m.type}, ${m.importance}) ${m.content}`)
                  .join("\n");
            break;
          }

          case "kioku_list_agents": {
            const agents = await storage.getAgents(userId);
            content = agents.length === 0
              ? "No agents."
              : agents
                  .map((a) => `• ${a.name} [${a.status}] — ${a.description ?? "no description"}`)
                  .join("\n");
            break;
          }

          case "kioku_list_memories": {
            const validatedArgs = mcpListMemoriesSchema.parse(args);
            const mems = await storage.getMemories(userId);
            const filtered = validatedArgs.namespace
              ? mems.filter((m) => m.namespace === validatedArgs.namespace)
              : mems;
            const slice = filtered.slice(0, 50);
            content = slice.length === 0
              ? "No memories."
              : slice
                  .map((m) => `[${m.namespace}] ${m.agentName ?? "?"}:\t${m.content}`)
                  .join("\n");
            break;
          }

          default:
            return res.json(rpcErr(id, -32601, `Unknown tool: ${toolName}`));
        }

        return res.json(
          ok(id, {
            content: [{ type: "text", text: content }],
            isError: false,
          })
        );
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          return res.json(rpcErr(id, -32602, `Invalid params: ${err.issues.map(i => i.message).join("; ")}`));
        }
        return res.json(rpcErr(id, -32000, err?.message ?? "Internal error"));
      }
    }

    // ── ping ──────────────────────────────────────────────────────────
    if (method === "ping") {
      return res.json(ok(id, {}));
    }

    return res.json(rpcErr(id, -32601, `Method not found: ${method}`));
  });
}
