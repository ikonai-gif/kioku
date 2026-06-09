/**
 * Brick 1.3 (LUCA-053) — getFriendlyTool mapping for the live action indicator.
 * Pure function (no React). Verifies that Luca's real V1a tool names + memory
 * ops resolve to a proper emoji + Russian verb (not the generic ⚙️ fallback),
 * and that unknown tools still fall back cleanly.
 */
import { describe, it, expect } from "vitest";
import { getFriendlyTool } from "@/components/TaskProgress";

describe("getFriendlyTool", () => {
  it("maps memory ops to emoji + verb", () => {
    expect(getFriendlyTool("remember")).toEqual({ icon: "💾", label: "Записываю в память" });
    expect(getFriendlyTool("recall")).toEqual({ icon: "🧠", label: "Вспоминаю" });
  });

  it("maps real luca_* tools (previously generic fallback)", () => {
    expect(getFriendlyTool("luca_search").icon).toBe("🔍");
    expect(getFriendlyTool("luca_run_code").icon).toBe("💻");
    expect(getFriendlyTool("luca_notion_create").label).toBe("Создаю в Notion");
    expect(getFriendlyTool("luca_email_read").icon).toBe("📧");
  });

  it("still maps pre-existing tools", () => {
    expect(getFriendlyTool("web_search").icon).toBe("🔍");
    expect(getFriendlyTool("generate_video").icon).toBe("🎬");
  });

  it("falls back to gear for unknown tools", () => {
    const r = getFriendlyTool("totally_unknown_tool");
    expect(r.icon).toBe("⚙️");
    expect(r.label).toBe("Totally Unknown Tool");
  });
});
