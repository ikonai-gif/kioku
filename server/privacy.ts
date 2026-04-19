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

  // ── GET /api/privacy/consent ────────────────────────────────────
  app.get("/api/privacy/consent", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { rows } = await pool.query(
      `SELECT consent_basic, consent_sensitive, consent_biometric, consent_ai_memory, consent_updated_at
       FROM users WHERE id = $1`, [userId]
    );
    const row = rows[0];
    res.json({
      basic: row?.consent_basic ?? false,
      sensitive: row?.consent_sensitive ?? false,
      biometric: row?.consent_biometric ?? false,
      aiMemory: row?.consent_ai_memory ?? true,
      updatedAt: row?.consent_updated_at || null,
    });
  }));

  // ── PUT /api/privacy/consent ──────────────────────────────────
  app.put("/api/privacy/consent", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { basic, sensitive, biometric, aiMemory } = req.body;
    await pool.query(
      `UPDATE users SET
        consent_basic = COALESCE($1, consent_basic),
        consent_sensitive = COALESCE($2, consent_sensitive),
        consent_biometric = COALESCE($3, consent_biometric),
        consent_ai_memory = COALESCE($4, consent_ai_memory),
        consent_updated_at = $5
       WHERE id = $6`,
      [basic, sensitive, biometric, aiMemory, Date.now(), userId]
    );

    // If sensitive consent revoked, delete health-related memories
    if (sensitive === false) {
      await pool.query(
        `DELETE FROM memories WHERE user_id = $1 AND (namespace = '_health' OR namespace = '_allergies' OR content ILIKE '%allerg%' OR content ILIKE '%skin condition%')`,
        [userId]
      );
    }
    // If biometric consent revoked, delete biometric data
    if (biometric === false) {
      await pool.query(
        `DELETE FROM memories WHERE user_id = $1 AND (namespace = '_biometric' OR namespace = '_face_scan')`,
        [userId]
      );
    }
    // If AI memory consent revoked, stop storing new memories
    if (aiMemory === false) {
      await pool.query(
        `DELETE FROM memories WHERE user_id = $1 AND namespace NOT IN ('_system', '_identity')`,
        [userId]
      );
    }

    res.json({ ok: true });
  }));

  // ── POST /api/privacy/age-verify ──────────────────────────────
  app.post("/api/privacy/age-verify", asyncHandler(async (req, res) => {
    const userId = await getUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { dateOfBirth, region } = req.body;
    if (!dateOfBirth) return res.status(400).json({ error: "Date of birth required" });

    const dob = new Date(dateOfBirth);
    const now = new Date();
    const age = Math.floor((now.getTime() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));

    // Determine minimum age based on region
    const minAge = (region === 'eu' || region === 'uk') ? 16 : 13;
    const isMinor = age < minAge;

    await pool.query(
      `UPDATE users SET date_of_birth = $1, age_verified = TRUE, region = COALESCE($2, region) WHERE id = $3`,
      [dateOfBirth, region, userId]
    );

    // If minor, disable AI memory and sensitive data collection
    if (isMinor) {
      await pool.query(
        `UPDATE users SET consent_ai_memory = FALSE, consent_sensitive = FALSE, consent_biometric = FALSE WHERE id = $1`,
        [userId]
      );
    }

    res.json({ ok: true, age, isMinor, minAge, aiMemoryEnabled: !isMinor });
  }));

  // ── POST /api/privacy/retention-cleanup ────────────────────────
  app.post("/api/privacy/retention-cleanup", asyncHandler(async (req, res) => {
    // Only master key can trigger
    const masterKey = process.env.KIOKU_MASTER_KEY;
    const apiKey = req.headers["x-api-key"];
    if (!masterKey || apiKey !== masterKey) return res.status(403).json({ error: "Forbidden" });

    const now = Date.now();
    const MONTHS_24 = 24 * 30 * 24 * 60 * 60 * 1000;
    const MONTHS_12 = 12 * 30 * 24 * 60 * 60 * 1000;

    // Delete health/allergy memories older than 24 months for inactive users
    const healthDeleted = await pool.query(
      `DELETE FROM memories WHERE namespace IN ('_health', '_allergies')
       AND created_at < $1
       AND user_id NOT IN (SELECT DISTINCT user_id FROM room_messages WHERE created_at > $2)
       RETURNING id`,
      [now - MONTHS_24, now - MONTHS_24]
    );

    // Delete preference memories older than 12 months for users with no activity
    const prefDeleted = await pool.query(
      `DELETE FROM memories WHERE namespace = '_preferences'
       AND created_at < $1
       AND user_id NOT IN (SELECT DISTINCT user_id FROM room_messages WHERE created_at > $2)
       RETURNING id`,
      [now - MONTHS_12, now - MONTHS_12]
    );

    // Delete expired agent turns
    const turnsDeleted = await pool.query(
      `DELETE FROM agent_turns WHERE status = 'expired' AND expires_at < $1 RETURNING id`,
      [now - MONTHS_12]
    );

    res.json({
      healthMemoriesDeleted: healthDeleted.rows.length,
      preferenceMemoriesDeleted: prefDeleted.rows.length,
      expiredTurnsDeleted: turnsDeleted.rows.length,
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
