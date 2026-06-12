/**
 * [LUCA-089 Part 3 / BRO2] Skills PR2 — agentskills.io interchange format.
 *
 * Pure mapping + validation helpers, unit-tested in isolation. KIOKU-only
 * fields travel under the kioku_extension namespace so exports stay
 * compatible with the public format.
 */

export interface AgentSkillExport {
  skill_id: string;
  name: string;
  category: string;
  description: string;
  prompt_template: string;
  trigger_patterns?: string[];
  tool_requirements?: string[];
  version: string;
  author: string;
  created_at: string;
  kioku_extension?: {
    auto_created: boolean;
    tool_sequence: string[];
    use_count: number;
  };
}

function parseToolSequence(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === "string");
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((t: unknown) => typeof t === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** DB row (snake_case, tool_sequence as TEXT) -> agentskills.io export shape. */
export function toAgentSkillExport(row: {
  id: number | string;
  name: string;
  category: string;
  description: string;
  prompt_template: string;
  trigger_pattern?: string | null;
  tool_sequence?: string | null;
  auto_created?: boolean;
  use_count?: number;
  created_at?: Date | string | null;
}): AgentSkillExport {
  const tools = parseToolSequence(row.tool_sequence);
  const created =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : typeof row.created_at === "string" && row.created_at
        ? new Date(row.created_at).toISOString()
        : new Date(0).toISOString();
  return {
    skill_id: `kioku-${String(row.id)}`,
    name: row.name,
    category: row.category,
    description: row.description,
    prompt_template: row.prompt_template,
    ...(row.trigger_pattern ? { trigger_patterns: [row.trigger_pattern] } : {}),
    ...(tools.length > 0 ? { tool_requirements: tools } : {}),
    version: "1.0.0",
    author: "kioku",
    created_at: created,
    kioku_extension: {
      auto_created: row.auto_created === true,
      tool_sequence: tools,
      use_count: typeof row.use_count === "number" ? row.use_count : 0,
    },
  };
}

export interface ParsedSkillImport {
  name: string;
  category: string;
  description: string;
  prompt_template: string;
  trigger_pattern: string | null;
  tool_sequence: string;
}

export type ImportParseResult =
  | { ok: true; value: ParsedSkillImport }
  | { ok: false; error: string };

/** Validate one incoming agentskills.io object -> insertable shape. */
export function parseAgentSkillImport(obj: unknown): ImportParseResult {
  if (typeof obj !== "object" || obj === null) return { ok: false, error: "not_an_object" };
  const o = obj as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return { ok: false, error: "missing_name" };
  if (name.length > 64) return { ok: false, error: "name_too_long" };
  const category = typeof o.category === "string" && o.category.trim() ? o.category.trim() : "imported";
  if (category.length > 32) return { ok: false, error: "category_too_long" };
  const description = typeof o.description === "string" ? o.description : "";
  const promptTemplate = typeof o.prompt_template === "string" ? o.prompt_template : "";
  if (!promptTemplate) return { ok: false, error: "missing_prompt_template" };
  const triggers = Array.isArray(o.trigger_patterns)
    ? o.trigger_patterns.filter((t): t is string => typeof t === "string")
    : [];
  const ext = (typeof o.kioku_extension === "object" && o.kioku_extension !== null)
    ? (o.kioku_extension as Record<string, unknown>)
    : {};
  const tools = Array.isArray(ext.tool_sequence)
    ? ext.tool_sequence.filter((t): t is string => typeof t === "string")
    : Array.isArray(o.tool_requirements)
      ? (o.tool_requirements as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
  return {
    ok: true,
    value: {
      name,
      category,
      description,
      prompt_template: promptTemplate,
      trigger_pattern: triggers.length > 0 ? triggers[0] : null,
      tool_sequence: JSON.stringify(tools),
    },
  };
}
