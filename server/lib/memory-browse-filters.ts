/**
 * P2.1 PR-1 — query-param parsing for GET /api/memories browse filters.
 *
 * Pure, DB-free, unit-testable. The route passes req.query here; storage
 * applies the typed filters under the existing app.user_id RLS context.
 * createdAfter/createdBefore are epoch-ms (memories.created_at is bigint ms).
 */
export interface MemoryBrowseFilters {
  namespace?: string;
  type?: string;
  agentId?: number;
  importanceMin?: number;
  importanceMax?: number;
  createdAfter?: number;
  createdBefore?: number;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function int(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.trunc(n);
}
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length ? s : undefined;
}

export function parseMemoryBrowseFilters(query: Record<string, unknown>): MemoryBrowseFilters {
  const f: MemoryBrowseFilters = {};
  const namespace = str(query.namespace);
  const type = str(query.type);
  const agentId = int(query.agent_id);
  const importanceMin = num(query.importance_min);
  const importanceMax = num(query.importance_max);
  const createdAfter = int(query.created_after);
  const createdBefore = int(query.created_before);
  if (namespace !== undefined) f.namespace = namespace;
  if (type !== undefined) f.type = type;
  if (agentId !== undefined) f.agentId = agentId;
  if (importanceMin !== undefined) f.importanceMin = importanceMin;
  if (importanceMax !== undefined) f.importanceMax = importanceMax;
  if (createdAfter !== undefined) f.createdAfter = createdAfter;
  if (createdBefore !== undefined) f.createdBefore = createdBefore;
  return f;
}

export function hasAnyFilter(f: MemoryBrowseFilters): boolean {
  return Object.keys(f).length > 0;
}
