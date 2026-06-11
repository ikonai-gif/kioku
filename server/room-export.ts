/**
 * Room Audit Export — build order #3, PR1 [BRO2-A8 / LUCA-072 / BRO4-002].
 *
 * Read-only JSON export of a single room: messages, deliberation transcript,
 * audit-log decisions, and memory provenance. No write path. Crypto signing
 * (Ed25519 / PDF/A-3 / W3C VC per BRO4-002) is explicitly deferred to PR2+.
 *
 * Privacy / exclusion contract (LUCA-072 Q3):
 *   - never include env vars or key material; a final secret-scrub pass runs
 *     over the serialized payload as defense-in-depth;
 *   - tool payloads reduced to name + status (no raw payloads);
 *   - memories from excluded namespaces are skipped
 *     (default: _self_monitoring, _emotional_state; extendable via
 *     EXPORT_EXCLUDE_NAMESPACES, comma-separated);
 *   - memory content tagged [patent] is replaced with a redaction marker;
 *   - rooms with patent_room=true are NOT exportable at all (K12–K20 privacy
 *     rule; stricter than LUCA-072 — deviation flagged in PR body).
 */

import { pool } from "./storage";

export const EXPORT_DEFAULT_EXCLUDED_NAMESPACES = [
  "_self_monitoring",
  "_emotional_state",
] as const;

export class PatentRoomExportBlockedError extends Error {
  readonly code = "PATENT_ROOM_EXPORT_BLOCKED";
  readonly status = 403;
  constructor(public roomId: number) {
    super(`room ${roomId} is a patent room — export is blocked (K12–K20 privacy rule)`);
    this.name = "PatentRoomExportBlockedError";
  }
}

/** Namespaces excluded from provenance export. Env-extendable, never reducible below defaults. */
export function excludedNamespaces(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>(EXPORT_DEFAULT_EXCLUDED_NAMESPACES);
  for (const ns of (env.EXPORT_EXCLUDE_NAMESPACES ?? "").split(",")) {
    const t = ns.trim();
    if (t) out.add(t);
  }
  return out;
}

/** LUCA-072 Q3: memory content tagged [patent] is redacted, not exported. */
export function redactPatentContent(content: string): string {
  return /\[patent\]/i.test(content) ? "[REDACTED: patent-sensitive]" : content;
}

/**
 * Defense-in-depth secret scrub over the final serialized payload.
 * Matches common key shapes (sk-..., key=..., OPENROUTER_/OPENAI_/etc. env
 * names with values). Acceptance criteria (LUCA-072 Q4) greps for these.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /sb_secret_[A-Za-z0-9_-]{8,}/g,
  /(OPENROUTER|OPENAI|ANTHROPIC|BRAVE_SEARCH|ELEVENLABS|STRIPE|TWILIO|SUPABASE)[A-Z_]*\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{12,}/g,
  /(api[_-]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{12,}/gi,
];

export function scrubSecrets(serialized: string): string {
  let out = serialized;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function excerpt(content: string, max = 200): string {
  return content.length <= max ? content : content.slice(0, max) + "…";
}

export function exportFilename(roomId: number, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `room-${roomId}-export-${ts}.json`;
}

export interface RoomExport {
  room_id: number;
  room_name: string;
  exported_at: string;
  messages: Array<{
    id: number;
    agent_id: number | null;
    agent_name: string;
    content: string;
    is_decision: boolean;
    created_at: number;
  }>;
  deliberation_transcript: Array<{
    id: number;
    session_id: string;
    phase: string;
    round: number;
    topic: string;
    status: string;
    response: unknown;
    created_at: number;
  }>;
  decisions: Array<{
    id: number;
    tool: string;
    classification: string;
    status: string;
    created_at: string;
  }>;
  provenance: Array<{
    memory_id: number;
    type: string;
    namespace: string | null;
    importance: number;
    provenance: string;
    content_excerpt: string;
    created_at: number;
  }>;
}

/**
 * Build the export for a room owned by userId. Returns null when the room
 * does not exist or is not owned by the user (no enumeration leak — same
 * contract as room-acl). Throws PatentRoomExportBlockedError for patent rooms.
 * Read-only: SELECTs only.
 */
export async function buildRoomExport(roomId: number, userId: number): Promise<RoomExport | null> {
  const roomRow = await pool.query(
    `SELECT id, name, patent_room FROM rooms WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [roomId, userId],
  );
  if (roomRow.rows.length === 0) return null;
  if (roomRow.rows[0].patent_room === true) throw new PatentRoomExportBlockedError(roomId);

  const messagesRes = await pool.query(
    `SELECT id, agent_id, agent_name, content, is_decision, created_at
       FROM room_messages WHERE room_id = $1 ORDER BY created_at ASC, id ASC`,
    [roomId],
  );
  const messages = messagesRes.rows.map((m: any) => ({
    id: m.id,
    agent_id: m.agent_id ?? null,
    agent_name: m.agent_name,
    content: m.content,
    is_decision: m.is_decision === true,
    created_at: Number(m.created_at),
  }));

  const turnsRes = await pool.query(
    `SELECT id, session_id, phase, round, topic, status, response, created_at
       FROM agent_turns WHERE room_id = $1 ORDER BY created_at ASC, id ASC`,
    [roomId],
  );
  const deliberation = turnsRes.rows.map((t: any) => {
    let response: unknown = null;
    if (t.response) {
      try { response = JSON.parse(t.response); } catch { response = excerpt(String(t.response)); }
    }
    return {
      id: t.id,
      session_id: t.session_id,
      phase: t.phase,
      round: t.round,
      topic: t.topic,
      status: t.status,
      response,
      created_at: Number(t.created_at),
    };
  });

  // Session window: first..last message timestamp (ms epoch). luca_audit_log
  // and memories have no room_id; scope them by userId + window (LUCA-072 Q2
  // anchor note: "замени имя, логика та же").
  const winStart = messages.length ? messages[0].created_at : null;
  const winEnd = messages.length ? messages[messages.length - 1].created_at : null;

  let decisions: RoomExport["decisions"] = [];
  let provenance: RoomExport["provenance"] = [];

  if (winStart !== null && winEnd !== null) {
    const auditRes = await pool.query(
      `SELECT id, tool, classification, status, created_at
         FROM luca_audit_log
        WHERE user_id = $1
          AND created_at >= to_timestamp($2::double precision / 1000)
          AND created_at <= to_timestamp($3::double precision / 1000)
        ORDER BY created_at ASC, id ASC`,
      [userId, winStart, winEnd],
    );
    decisions = auditRes.rows.map((d: any) => ({
      id: d.id,
      tool: d.tool,
      classification: d.classification,
      status: d.status,
      created_at: new Date(d.created_at).toISOString(),
    }));

    const excluded = Array.from(excludedNamespaces());
    const memRes = await pool.query(
      `SELECT id, type, namespace, importance, provenance, content, created_at
         FROM memories
        WHERE user_id = $1
          AND created_at >= $2 AND created_at <= $3
          AND (namespace IS NULL OR NOT (namespace = ANY($4::text[])))
        ORDER BY created_at ASC, id ASC`,
      [userId, winStart, winEnd, excluded],
    );
    provenance = memRes.rows.map((m: any) => ({
      memory_id: m.id,
      type: m.type,
      namespace: m.namespace ?? null,
      importance: Number(m.importance),
      provenance: m.provenance,
      content_excerpt: excerpt(redactPatentContent(String(m.content))),
      created_at: Number(m.created_at),
    }));
  }

  return {
    room_id: roomId,
    room_name: roomRow.rows[0].name,
    exported_at: new Date().toISOString(),
    messages,
    deliberation_transcript: deliberation,
    decisions,
    provenance,
  };
}

/** Serialize with the final secret scrub. Route sends this verbatim. */
export function serializeRoomExport(payload: RoomExport): string {
  return scrubSecrets(JSON.stringify(payload, null, 2));
}
