import type { Express, Request, Response, NextFunction } from "express";
import { pool } from "./storage";
import { randomBytes } from "crypto";

// Async error wrapper
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function registerPrivacyRoutes(app: Express, getUser: (req: any) => Promise<number | null>) {

  // ── GET /api/privacy/summary ──────────────────────────────────
  app.get("/api/privacy/summary", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const [memoryResult, agentResult, integrationResult] = await Promise.all([
      pool.query("SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(content)), 0) as total_size FROM memories WHERE user_id = $1", [userId]),
      pool.query("SELECT COUNT(*) as count FROM agents WHERE user_id = $1", [userId]),
      pool.query("SELECT COUNT(*) as count FROM user_integrations WHERE user_id = $1", [userId]),
    ]);

    const memoryCount = parseInt(memoryResult.rows[0]?.count || "0", 10);
    const dataSize = parseInt(memoryResult.rows[0]?.total_size || "0", 10);
    const agentCount = parseInt(agentResult.rows[0]?.count || "0", 10);
    const connectedServices = parseInt(integrationResult.rows[0]?.count || "0", 10);

    res.json({
      memoryCount,
      conversationCount: agentCount,
      connectedServices,
      dataSize,
      dataSizeFormatted: dataSize > 1048576
        ? `${(dataSize / 1048576).toFixed(1)} MB`
        : `${(dataSize / 1024).toFixed(1)} KB`,
    });
  }));

  // ── GET /api/privacy/memories ─────────────────────────────────
  app.get("/api/privacy/memories", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const search = (req.query.search as string) || "";
    const type = (req.query.type as string) || "";
    const page = parseInt((req.query.page as string) || "1", 10);
    const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 100);
    const offset = (page - 1) * limit;

    let whereClause = "WHERE user_id = $1";
    const params: any[] = [userId];
    let paramIdx = 2;

    if (search) {
      whereClause += ` AND content ILIKE $${paramIdx}`;
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (type) {
      whereClause += ` AND type = $${paramIdx}`;
      params.push(type);
      paramIdx++;
    }

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) as count FROM memories ${whereClause}`, params),
      pool.query(
        `SELECT id, content, type, importance, agent_name, namespace, created_at, LENGTH(content) as size
         FROM memories ${whereClause}
         ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
    ]);

    res.json({
      memories: dataResult.rows.map((r: any) => ({
        id: r.id,
        content: r.content,
        type: r.type,
        importance: r.importance,
        agentName: r.agent_name,
        namespace: r.namespace,
        createdAt: r.created_at,
        size: r.size,
      })),
      total: parseInt(countResult.rows[0]?.count || "0", 10),
      page,
      limit,
    });
  }));

  // ── DELETE /api/privacy/memories/:id ──────────────────────────
  app.delete("/api/privacy/memories/:id", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const memoryId = parseInt(req.params.id as string, 10);
    if (isNaN(memoryId)) return res.status(400).json({ error: "Invalid memory ID" });

    const result = await pool.query(
      "DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id",
      [memoryId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Memory not found" });
    }

    res.json({ ok: true, deleted: memoryId });
  }));

  // ── DELETE /api/privacy/memories (bulk) ───────────────────────
  app.delete("/api/privacy/memories", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: "Maximum 500 IDs per request" });
    }

    const placeholders = ids.map((_: any, i: number) => `$${i + 2}`).join(",");
    const result = await pool.query(
      `DELETE FROM memories WHERE user_id = $1 AND id IN (${placeholders}) RETURNING id`,
      [userId, ...ids]
    );

    res.json({ ok: true, deleted: result.rowCount });
  }));

  // ── POST /api/privacy/data-request ────────────────────────────
  app.post("/api/privacy/data-request", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Generate a request token for tracking
    const requestToken = randomBytes(16).toString("hex");

    // In production this would queue an async job; for now return immediately
    const [userResult, memoriesResult, agentsResult] = await Promise.all([
      pool.query("SELECT id, email, name, company, plan, created_at FROM users WHERE id = $1", [userId]),
      pool.query("SELECT id, content, type, importance, agent_name, namespace, created_at FROM memories WHERE user_id = $1 ORDER BY created_at DESC", [userId]),
      pool.query("SELECT id, name, description, color, status, created_at FROM agents WHERE user_id = $1", [userId]),
    ]);

    res.json({
      requestId: requestToken,
      status: "ready",
      data: {
        exportDate: new Date().toISOString(),
        user: userResult.rows[0] || null,
        memories: memoriesResult.rows,
        agents: agentsResult.rows,
      },
    });
  }));

  // ── DELETE /api/privacy/account-data ──────────────────────────
  app.delete("/api/privacy/account-data", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { confirmToken } = req.body;
    if (confirmToken !== "DELETE_ALL_MY_DATA") {
      return res.status(400).json({ error: "Must provide confirmToken: 'DELETE_ALL_MY_DATA'" });
    }

    // Delete user data in dependency order
    await pool.query("DELETE FROM memories WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM memory_links WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM agents WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM flows WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM rooms WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM logs WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM user_integrations WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1", [userId]);

    res.json({ ok: true, message: "All user data has been deleted" });
  }));

  // ── GET /api/privacy/training-consent ─────────────────────────
  app.get("/api/privacy/training-consent", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const result = await pool.query(
      "SELECT training_consent, training_categories FROM users WHERE id = $1",
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const row = result.rows[0];
    res.json({
      allowTraining: row.training_consent ?? false,
      allowedCategories: row.training_categories ?? [],
    });
  }));

  // ── PUT /api/privacy/training-consent ─────────────────────────
  app.put("/api/privacy/training-consent", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { allowTraining, allowedCategories } = req.body;

    if (typeof allowTraining !== "boolean") {
      return res.status(400).json({ error: "allowTraining must be a boolean" });
    }

    const validCategories = ["conversations", "memories", "preferences", "tasks"];
    const categories = Array.isArray(allowedCategories)
      ? allowedCategories.filter((c: string) => validCategories.includes(c))
      : [];

    await pool.query(
      "UPDATE users SET training_consent = $1, training_categories = $2 WHERE id = $3",
      [allowTraining, JSON.stringify(categories), userId]
    );

    res.json({
      ok: true,
      allowTraining,
      allowedCategories: categories,
    });
  }));
}
