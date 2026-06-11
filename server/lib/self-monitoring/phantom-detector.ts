/**
 * KIOKU™ A5 — Luca Phantom-Tool Detector  [BRO2-327 / LUCA-067]  (report-only, PR1)
 *
 * Compares Luca's `_identity` memory tool-claims against her runtime-effective
 * tool scope (`getLucaStudioToolNames()` — the source of truth per LUCA-067 Q1)
 * and reports phantom claims (a stale "I have N tools" / "I have <tool>" that no
 * longer matches reality — e.g. memory id=698 "19 tools" while effective=49).
 *
 * REPORT-ONLY: this module NEVER mutates the memories table. The automatic
 * `correct_false_memory` path is deferred to PR2 after a real-data dry run —
 * BRO2 + LUCA agreed the NLP claim extraction is fragile and must not auto-edit
 * `_identity` memory until validated on production data.
 *
 * Gate: do NOT flip `LUCA_DEV_SCOPE_ENABLED` in prod until status === "CLEAN".
 *
 * The detector core (`detectPhantoms` / `extractToolClaims`) is PURE — no HTTP,
 * no DB — and is unit tested. `runPhantomScan` does the live fetch: effective
 * scope + `_identity` rows from Neon (`memories` table), per LUCA-067 Q2.
 */
import { pool } from "../../storage";
import { getLucaStudioToolNames, getPartnerToolsForAgent } from "../../deliberation";
import { readLucaEnv } from "../luca/env";

export type PhantomStatus = "CLEAN" | "PHANTOM_FOUND";

export interface PhantomClaim {
  memory_id: number;
  kind: "named_tool" | "tool_count";
  claim: string;
  detail: string;
}

export interface PhantomReport {
  status: PhantomStatus;
  phantoms: PhantomClaim[];
  /**
   * Effective tools never referenced in any `_identity` memory. INFORMATIONAL
   * ONLY — does NOT affect `status` (Luca is not expected to enumerate every
   * tool she has, so this is the normal state and must not block the flag gate).
   * NOTE for LUCA: LUCA-067 listed a `MISSING_CLAIMS` status; PR1 keeps `missing`
   * informational so `CLEAN` stays reachable. Confirm if you want it promoted.
   */
  missing: string[];
  k17_verified: boolean;
  effective_count: number;
  checked_memories: number;
  timestamp: string;
}

/**
 * DEV-scope tools admitted by PR #226 (env.ts:149/233/270). K17 invariant:
 * these must be ABSENT from effective scope while LUCA_DEV_SCOPE_ENABLED=false,
 * and PRESENT when it is true.
 */
export const DEV_SCOPE_TOOLS: readonly string[] = [
  "sandbox_shell", "sandbox_write_file", "sandbox_read_file", "sandbox_list_files",
  "sandbox_download", "reset_sandbox", "build_project", "delegate_task", "delegate_parallel",
];

// "19 tools" / "19 инструментов" / "19 тулзов" — a numeric capability claim.
const COUNT_CLAIM_RE = /(\d{1,3})\s*(?:tools?|инструмент\w*|тулз\w*)/giu;

// A tool token only counts as a *claim* if a possession cue sits within
// POSSESSION_WINDOW chars of it — keeps incidental mentions (e.g. "the
// sandbox_shell handler lives in deliberation.ts") from flagging.
const POSSESSION_RE = /(have|has|my |mine|access to|у меня|есть|мои|мо[йяёе]|имею|владею|располагаю)/iu;
const POSSESSION_WINDOW = 48;

/** Pure extraction of capability claims from one memory's text. */
export function extractToolClaims(
  content: string,
  vocab: ReadonlySet<string>,
): { named: string[]; counts: number[] } {
  const text = content ?? "";
  const lower = text.toLowerCase();

  const counts: number[] = [];
  for (const m of text.matchAll(COUNT_CLAIM_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) counts.push(n);
  }

  const named: string[] = [];
  for (const tool of vocab) {
    const t = tool.toLowerCase();
    let idx = lower.indexOf(t);
    while (idx !== -1) {
      const before = lower[idx - 1];
      const after = lower[idx + t.length];
      const boundedL = idx === 0 || !/[a-z0-9_]/.test(before ?? "");
      const boundedR = !/[a-z0-9_]/.test(after ?? "");
      if (boundedL && boundedR) {
        const ws = Math.max(0, idx - POSSESSION_WINDOW);
        const we = Math.min(text.length, idx + t.length + POSSESSION_WINDOW);
        if (POSSESSION_RE.test(text.slice(ws, we))) {
          named.push(tool);
          break;
        }
      }
      idx = lower.indexOf(t, idx + t.length);
    }
  }
  return { named: Array.from(new Set(named)), counts };
}

export interface DetectInput {
  effective: ReadonlySet<string>;
  vocab: ReadonlySet<string>;
  memories: ReadonlyArray<{ id: number; content: string }>;
  devScopeEnabled: boolean;
  now?: Date;
}

/** Pure detector: compare `_identity` claims vs effective scope. No side-effects. */
export function detectPhantoms(input: DetectInput): PhantomReport {
  const { effective, vocab, memories, devScopeEnabled } = input;
  const effCount = effective.size;
  const phantoms: PhantomClaim[] = [];
  const referenced = new Set<string>();

  for (const mem of memories) {
    const { named, counts } = extractToolClaims(mem.content, vocab);
    for (const tool of named) {
      referenced.add(tool);
      if (!effective.has(tool)) {
        phantoms.push({
          memory_id: mem.id,
          kind: "named_tool",
          claim: tool,
          detail: `claims tool '${tool}' but it is NOT in effective scope`,
        });
      }
    }
    for (const n of counts) {
      if (n !== effCount) {
        phantoms.push({
          memory_id: mem.id,
          kind: "tool_count",
          claim: String(n),
          detail: `claims ${n} tools but effective scope has ${effCount}`,
        });
      }
    }
  }

  const missing = Array.from(effective).filter((t) => !referenced.has(t)).sort();
  const k17_verified = DEV_SCOPE_TOOLS.every((t) => effective.has(t) === devScopeEnabled);

  return {
    status: phantoms.length > 0 ? "PHANTOM_FOUND" : "CLEAN",
    phantoms,
    missing,
    k17_verified,
    effective_count: effCount,
    checked_memories: memories.length,
    timestamp: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * Live scan: fetch effective scope + Luca's `_identity` memories from Neon and
 * run the pure detector. REPORT-ONLY — never writes to the `memories` table.
 *
 * Defaults: userId=10 (BOSS), agentId=16 (Luca) — per LUCA-067 Q2.
 */
export async function runPhantomScan(
  opts: { userId?: number; agentId?: number } = {},
): Promise<PhantomReport> {
  const userId = opts.userId ?? 10;
  const agentId = opts.agentId ?? 16;

  const effective = getLucaStudioToolNames();
  const env = readLucaEnv();

  const res = await pool.query(
    `SELECT id, content
       FROM memories
      WHERE namespace = '_identity'
        AND user_id = $1
        AND (agent_id = $2 OR agent_id IS NULL)
      ORDER BY id`,
    [userId, agentId],
  );
  const memories = (res.rows as any[]).map((r) => ({
    id: Number(r.id),
    content: String(r.content ?? ""),
  }));

  const schemaTools = getPartnerToolsForAgent({ name: "Luca" }).map((t) => t.name);
  const vocab = new Set<string>([...schemaTools, ...DEV_SCOPE_TOOLS, ...effective]);

  return detectPhantoms({
    effective,
    vocab,
    memories,
    devScopeEnabled: env.LUCA_DEV_SCOPE_ENABLED,
  });
}
