/**
 * Phase 6 PR-A (R-luca-computer-ui) — unit tests for the canvas mode
 * router pure logic. Covers BRO1 R446 corrections:
 *   • Q1 — VIEWPORT_MIN_PX hard-pins chat below 900px regardless of override
 *   • Q2 — only luca_agent_browser + browse_website trigger computer mode
 *          (run_code / read_url / screenshot / etc. must NOT)
 *   • localStorage persistence: chat/computer persisted, auto wipes key,
 *     graceful fallback when storage throws.
 */

import { describe, it, expect } from "vitest";

import {
  COMPUTER_MODE_TOOLS,
  VIEWPORT_MIN_PX,
  detectComputerStepRunning,
  isComputerModeTool,
  nextOverrideForToggle,
  readStoredOverride,
  resolveMode,
  writeStoredOverride,
} from "../../client/src/lib/luca-canvas-mode";

// ── In-memory localStorage shim ──────────────────────────────────────

function makeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() { map.clear(); },
    getItem(k: string) { return map.has(k) ? map.get(k)! : null; },
    setItem(k: string, v: string) { map.set(k, String(v)); },
    removeItem(k: string) { map.delete(k); },
    key(i: number) { return Array.from(map.keys())[i] ?? null; },
  };
}

function makeThrowingStorage(): Storage {
  return {
    get length() { return 0; },
    clear() { throw new Error("nope"); },
    getItem() { throw new Error("nope"); },
    setItem() { throw new Error("nope"); },
    removeItem() { throw new Error("nope"); },
    key() { throw new Error("nope"); },
  };
}

// ── isComputerModeTool / COMPUTER_MODE_TOOLS ─────────────────────────

describe("isComputerModeTool — BRO1 R446 Q2 (auto-trigger scope)", () => {
  it("matches the canonical computer-mode tool names", () => {
    expect(isComputerModeTool("luca_agent_browser")).toBe(true);
    expect(isComputerModeTool("browse_website")).toBe(true);
  });

  it("rejects fast tools (run_code / read_url / screenshot) — would cause flicker", () => {
    expect(isComputerModeTool("luca_run_code")).toBe(false);
    expect(isComputerModeTool("luca_read_url")).toBe(false);
    expect(isComputerModeTool("luca_screenshot")).toBe(false);
    expect(isComputerModeTool("luca_workspace_save")).toBe(false);
    expect(isComputerModeTool("luca_analyze_image")).toBe(false);
  });

  it("rejects unknown / null / undefined / empty input", () => {
    expect(isComputerModeTool(null)).toBe(false);
    expect(isComputerModeTool(undefined)).toBe(false);
    expect(isComputerModeTool("")).toBe(false);
    expect(isComputerModeTool("agent_browser")).toBe(false); // pre-luca_ rename
  });

  it("exposes a frozen-style readonly tuple of tool names", () => {
    expect(COMPUTER_MODE_TOOLS).toEqual(["luca_agent_browser", "browse_website"]);
  });
});

// ── detectComputerStepRunning ────────────────────────────────────────

describe("detectComputerStepRunning", () => {
  it("returns true when at least one running computer-mode tool exists", () => {
    expect(detectComputerStepRunning([
      { tool: "luca_run_code", status: "running" },
      { tool: "luca_agent_browser", status: "running" },
    ])).toBe(true);
  });

  it("ignores non-running rows even if tool matches", () => {
    expect(detectComputerStepRunning([
      { tool: "luca_agent_browser", status: "done" },
      { tool: "browse_website", status: "error" },
    ])).toBe(false);
  });

  it("ignores rows with non-computer tools even if running", () => {
    expect(detectComputerStepRunning([
      { tool: "luca_run_code", status: "running" },
      { tool: "luca_read_url", status: "running" },
    ])).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(detectComputerStepRunning([])).toBe(false);
  });

  it("treats missing tool/status as non-trigger", () => {
    expect(detectComputerStepRunning([{}, { tool: null, status: null }])).toBe(false);
  });
});

// ── resolveMode ──────────────────────────────────────────────────────

describe("resolveMode — BRO1 R446 Q1 (responsive breakpoint)", () => {
  it("forces chat below VIEWPORT_MIN_PX even when override=computer", () => {
    expect(resolveMode({
      override: "computer",
      hasComputerStep: true,
      viewportWidth: VIEWPORT_MIN_PX - 1,
    })).toBe("chat");
  });

  it("forces chat below VIEWPORT_MIN_PX even with running computer step + auto", () => {
    expect(resolveMode({
      override: "auto",
      hasComputerStep: true,
      viewportWidth: 600,
    })).toBe("chat");
  });

  it("respects user override 'chat' on wide viewport with running step", () => {
    expect(resolveMode({
      override: "chat",
      hasComputerStep: true,
      viewportWidth: 1440,
    })).toBe("chat");
  });

  it("respects user override 'computer' on wide viewport without running step", () => {
    expect(resolveMode({
      override: "computer",
      hasComputerStep: false,
      viewportWidth: 1440,
    })).toBe("computer");
  });

  it("auto + running step + wide viewport → computer", () => {
    expect(resolveMode({
      override: "auto",
      hasComputerStep: true,
      viewportWidth: 1280,
    })).toBe("computer");
  });

  it("auto + idle + wide viewport → chat", () => {
    expect(resolveMode({
      override: "auto",
      hasComputerStep: false,
      viewportWidth: 1280,
    })).toBe("chat");
  });

  it("VIEWPORT_MIN_PX is exactly 900 (BRO1 R446)", () => {
    expect(VIEWPORT_MIN_PX).toBe(900);
  });
});

// ── localStorage persistence ─────────────────────────────────────────

describe("readStoredOverride / writeStoredOverride", () => {
  it("returns 'auto' when nothing is stored", () => {
    const s = makeStorage();
    expect(readStoredOverride(42, s)).toBe("auto");
  });

  it("round-trips chat and computer per roomId", () => {
    const s = makeStorage();
    writeStoredOverride(7, "chat", s);
    writeStoredOverride(8, "computer", s);
    expect(readStoredOverride(7, s)).toBe("chat");
    expect(readStoredOverride(8, s)).toBe("computer");
  });

  it("writing 'auto' clears the key", () => {
    const s = makeStorage({ "luca:layout:9": "computer" });
    writeStoredOverride(9, "auto", s);
    expect(readStoredOverride(9, s)).toBe("auto");
    expect(s.getItem("luca:layout:9")).toBeNull();
  });

  it("falls back to 'auto' when storage is null (SSR)", () => {
    expect(readStoredOverride(1, null)).toBe("auto");
    expect(() => writeStoredOverride(1, "computer", null)).not.toThrow();
  });

  it("falls back to 'auto' when storage throws (private mode)", () => {
    const s = makeThrowingStorage();
    expect(readStoredOverride(1, s)).toBe("auto");
    expect(() => writeStoredOverride(1, "computer", s)).not.toThrow();
  });

  it("ignores invalid stored values", () => {
    const s = makeStorage({ "luca:layout:1": "garbage" });
    expect(readStoredOverride(1, s)).toBe("auto");
  });

  it("uses room-scoped key prefix", () => {
    const s = makeStorage();
    writeStoredOverride(5, "computer", s);
    expect(s.getItem("luca:layout:5")).toBe("computer");
  });
});

// ── nextOverrideForToggle ────────────────────────────────────────────

describe("nextOverrideForToggle", () => {
  it("flips computer → chat", () => {
    expect(nextOverrideForToggle("computer")).toBe("chat");
  });

  it("flips chat → computer", () => {
    expect(nextOverrideForToggle("chat")).toBe("computer");
  });
});
