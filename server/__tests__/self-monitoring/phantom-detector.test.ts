/**
 * A5 phantom-tool detector — unit tests (pure core, no DB/HTTP).
 *
 * Covers the LUCA-067 spec acceptance shape:
 *   - numeric count-claim mismatch (the real id=698 "19 tools" phantom)
 *   - named-tool claim absent from effective scope
 *   - possession-cue gating + token boundaries (avoid false phantoms)
 *   - K17 invariant (flag <-> DEV-tool presence)
 *   - CLEAN path
 */
import { describe, expect, it } from "vitest";
import {
  detectPhantoms,
  extractToolClaims,
  DEV_SCOPE_TOOLS,
} from "../../lib/self-monitoring/phantom-detector";

// 5 effective tools → effective_count = 5 (a "5 tools" claim is truthful).
const EFFECTIVE = new Set<string>([
  "luca_search",
  "luca_read_url",
  "luca_recall_self",
  "luca_self_config",
  "luca_read_repo",
]);
const VOCAB = new Set<string>([...EFFECTIVE, ...DEV_SCOPE_TOOLS, "web_search"]);
const base = { effective: EFFECTIVE, vocab: VOCAB, devScopeEnabled: false } as const;

describe("extractToolClaims", () => {
  it("detects numeric count claims (RU + EN)", () => {
    expect(extractToolClaims("сейчас у меня 19 инструментов", VOCAB).counts).toContain(19);
    expect(extractToolClaims("I currently have 19 tools", VOCAB).counts).toContain(19);
  });

  it("flags a named tool only with a possession cue", () => {
    expect(extractToolClaims("у меня есть sandbox_shell для команд", VOCAB).named).toContain("sandbox_shell");
    // bare mention, no possession cue → not a claim
    expect(extractToolClaims("the sandbox_shell handler lives in deliberation.ts", VOCAB).named).not.toContain("sandbox_shell");
  });

  it("respects token boundaries", () => {
    expect(extractToolClaims("I have xbuild_projectx somewhere", VOCAB).named).not.toContain("build_project");
  });
});

describe("detectPhantoms (report-only)", () => {
  it("flags the id=698-style stale count claim (19 vs 5)", () => {
    const r = detectPhantoms({ ...base, memories: [{ id: 698, content: "у меня 19 инструментов" }] });
    expect(r.status).toBe("PHANTOM_FOUND");
    expect(r.phantoms.some((p) => p.kind === "tool_count" && p.memory_id === 698)).toBe(true);
  });

  it("flags a named tool claimed but absent from effective scope", () => {
    const r = detectPhantoms({ ...base, memories: [{ id: 1, content: "у меня есть sandbox_shell" }] });
    expect(r.status).toBe("PHANTOM_FOUND");
    expect(r.phantoms.some((p) => p.kind === "named_tool" && p.claim === "sandbox_shell")).toBe(true);
  });

  it("CLEAN when claims match effective scope", () => {
    const r = detectPhantoms({
      ...base,
      memories: [{ id: 2, content: "I have luca_search and luca_read_url; in total 5 tools" }],
    });
    expect(r.status).toBe("CLEAN");
    expect(r.phantoms).toHaveLength(0);
  });

  it("is pure: timestamp from injected now, no input mutation", () => {
    const now = new Date("2026-06-11T00:00:00.000Z");
    const r = detectPhantoms({ ...base, memories: [], now });
    expect(r.timestamp).toBe("2026-06-11T00:00:00.000Z");
    expect(r.checked_memories).toBe(0);
    expect(r.effective_count).toBe(EFFECTIVE.size);
  });

  it("K17: flag OFF and all DEV tools absent → verified true", () => {
    expect(detectPhantoms({ ...base, memories: [] }).k17_verified).toBe(true);
  });

  it("K17: flag OFF but a DEV tool leaked into effective → verified false", () => {
    const leaked = new Set<string>([...EFFECTIVE, "sandbox_shell"]);
    const r = detectPhantoms({ effective: leaked, vocab: VOCAB, devScopeEnabled: false, memories: [] });
    expect(r.k17_verified).toBe(false);
  });

  it("K17: flag ON and all DEV tools present → verified true", () => {
    const full = new Set<string>([...EFFECTIVE, ...DEV_SCOPE_TOOLS]);
    const r = detectPhantoms({ effective: full, vocab: VOCAB, devScopeEnabled: true, memories: [] });
    expect(r.k17_verified).toBe(true);
  });
});
