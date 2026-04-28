/**
 * Luca Day 6 — classify.ts unit tests.
 *
 * Exercises the TOOL_WRITE_CLASS table, name-only classifyTool,
 * input-aware classifyToolCall, and the UNADMITTED_TOOLS/admissible
 * set invariants.
 *
 * Critical invariants:
 *   - fail-closed unknown → HIGH
 *   - V1a tools all READ_ONLY
 *   - email sends HIGH
 *   - workspace_save path-based downgrade
 *   - schedule_task action_type-based downgrade
 *   - admissible ∩ unadmitted = ∅ (no tool classified both ways)
 */
import { describe, expect, it } from "vitest";
import {
  TOOL_WRITE_CLASS,
  UNADMITTED_TOOLS,
  classifyTool,
  classifyToolCall,
  isAdmissibleTool,
  type LucaAdmissibleTool,
  type ToolWriteClass,
} from "../../lib/luca-approvals/classify";

describe("classify: TOOL_WRITE_CLASS table", () => {
  it("every entry has a valid class label", () => {
    const valid: ReadonlySet<ToolWriteClass> = new Set([
      "READ_ONLY",
      "LOW_STAKES_WRITE",
      "HIGH_STAKES_WRITE",
    ]);
    for (const [name, cls] of Object.entries(TOOL_WRITE_CLASS)) {
      expect(valid.has(cls as ToolWriteClass), `${name} has invalid class ${cls}`).toBe(true);
    }
  });

  it("all 4 V1a tools classify READ_ONLY (sandboxed/whitelist-fenced)", () => {
    expect(TOOL_WRITE_CLASS.luca_run_code).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.luca_analyze_image).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.luca_search).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.luca_read_url).toBe("READ_ONLY");
  });

  it("email sends are HIGH_STAKES_WRITE (approval required every call)", () => {
    expect(TOOL_WRITE_CLASS.send_email_reply).toBe("HIGH_STAKES_WRITE");
    expect(TOOL_WRITE_CLASS.send_new_email).toBe("HIGH_STAKES_WRITE");
  });

  it("Gmail reads are READ_ONLY (content is UNTRUSTED but no side-effect)", () => {
    expect(TOOL_WRITE_CLASS.gmail_search).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.gmail_read).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.inbox_list).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.inbox_read).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.read_email_thread).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.search_emails).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.email_triage).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.gmail_accounts_status).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.gmail_reconnect_link).toBe("READ_ONLY");
  });

  it("inbox_action is LOW (all current sub-actions are idempotent)", () => {
    expect(TOOL_WRITE_CLASS.inbox_action).toBe("LOW_STAKES_WRITE");
  });

  it("workspace_save is HIGH by name (upper bound; path downgrades at classifyToolCall)", () => {
    expect(TOOL_WRITE_CLASS.workspace_save).toBe("HIGH_STAKES_WRITE");
  });

  it("workspace_read/list are READ_ONLY", () => {
    expect(TOOL_WRITE_CLASS.workspace_read).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.workspace_list).toBe("READ_ONLY");
  });

  it("produce_season is HIGH ($$$), produce_episode is LOW (acceptable cost)", () => {
    expect(TOOL_WRITE_CLASS.produce_season).toBe("HIGH_STAKES_WRITE");
    expect(TOOL_WRITE_CLASS.produce_episode).toBe("LOW_STAKES_WRITE");
  });

  it("remember is LOW (Luca's own memory authority)", () => {
    expect(TOOL_WRITE_CLASS.remember).toBe("LOW_STAKES_WRITE");
  });

  it("schedule_task is HIGH by name (worst case: schedules an email send)", () => {
    expect(TOOL_WRITE_CLASS.schedule_task).toBe("HIGH_STAKES_WRITE");
  });

  it("set_reminder is LOW (self-notify, no external recipient)", () => {
    expect(TOOL_WRITE_CLASS.set_reminder).toBe("LOW_STAKES_WRITE");
  });

  it("cloud file reads are READ_ONLY (content is UNTRUSTED but no write)", () => {
    expect(TOOL_WRITE_CLASS.search_cloud_files).toBe("READ_ONLY");
    expect(TOOL_WRITE_CLASS.read_cloud_file).toBe("READ_ONLY");
  });

  it("ephemeral media generation tools are LOW", () => {
    expect(TOOL_WRITE_CLASS.generate_image).toBe("LOW_STAKES_WRITE");
    expect(TOOL_WRITE_CLASS.generate_video).toBe("LOW_STAKES_WRITE");
    expect(TOOL_WRITE_CLASS.generate_music).toBe("LOW_STAKES_WRITE");
    expect(TOOL_WRITE_CLASS.generate_speech).toBe("LOW_STAKES_WRITE");
    expect(TOOL_WRITE_CLASS.generate_sfx).toBe("LOW_STAKES_WRITE");
  });

  it("clone_voice is HIGH (Luca N1: persistent voice_id is a biometric asset)", () => {
    expect(TOOL_WRITE_CLASS.clone_voice).toBe("HIGH_STAKES_WRITE");
  });
});

describe("classify: classifyTool (by name)", () => {
  it("returns the table value for admissible tools", () => {
    expect(classifyTool("luca_run_code")).toBe("READ_ONLY");
    expect(classifyTool("send_new_email")).toBe("HIGH_STAKES_WRITE");
    expect(classifyTool("remember")).toBe("LOW_STAKES_WRITE");
  });

  it("unknown tool → HIGH_STAKES_WRITE (fail-closed)", () => {
    expect(classifyTool("frobnicate_the_widget")).toBe("HIGH_STAKES_WRITE");
    expect(classifyTool("")).toBe("HIGH_STAKES_WRITE");
    expect(classifyTool("composio_action")).toBe("HIGH_STAKES_WRITE");
    expect(classifyTool("sandbox_shell")).toBe("HIGH_STAKES_WRITE");
  });

  it("isAdmissibleTool narrows correctly", () => {
    expect(isAdmissibleTool("luca_run_code")).toBe(true);
    expect(isAdmissibleTool("send_new_email")).toBe(true);
    expect(isAdmissibleTool("composio_action")).toBe(false);
    expect(isAdmissibleTool("nonexistent")).toBe(false);
  });
});

describe("classify: classifyToolCall (input-aware)", () => {
  it("never upgrades a non-HIGH tool regardless of payload", () => {
    expect(classifyToolCall("luca_run_code", { anything: true })).toBe("READ_ONLY");
    expect(classifyToolCall("remember", { type: "reflection", content: "x" })).toBe(
      "LOW_STAKES_WRITE",
    );
    expect(classifyToolCall("inbox_action", { action: "archive", account: "a", id: "1" })).toBe(
      "LOW_STAKES_WRITE",
    );
  });

  it("workspace_save to /luca/ downgrades to LOW", () => {
    expect(
      classifyToolCall("workspace_save", { path: "/luca/notes.md", content: "hi" }),
    ).toBe("LOW_STAKES_WRITE");
    expect(
      classifyToolCall("workspace_save", { path: "/luca/series/bible.md", content: "hi" }),
    ).toBe("LOW_STAKES_WRITE");
  });

  it("workspace_save outside /luca/ stays HIGH", () => {
    expect(
      classifyToolCall("workspace_save", { path: "/shared/memo.md", content: "hi" }),
    ).toBe("HIGH_STAKES_WRITE");
    expect(classifyToolCall("workspace_save", { path: "notes.md", content: "hi" })).toBe(
      "HIGH_STAKES_WRITE",
    );
    expect(classifyToolCall("workspace_save", {})).toBe("HIGH_STAKES_WRITE");
  });

  it("schedule_task self-message downgrades to LOW", () => {
    expect(
      classifyToolCall("schedule_task", {
        title: "daily check",
        description: "ping me",
        schedule: "0 9 * * *",
        action_type: "message",
        action_payload: JSON.stringify({ body: "hello self" }),
      }),
    ).toBe("LOW_STAKES_WRITE");
  });

  it("schedule_task with external recipient stays HIGH", () => {
    expect(
      classifyToolCall("schedule_task", {
        title: "send alice",
        description: "email alice",
        schedule: "0 9 * * *",
        action_type: "message",
        action_payload: JSON.stringify({ to: "alice@example.com", body: "hi" }),
      }),
    ).toBe("HIGH_STAKES_WRITE");
    expect(
      classifyToolCall("schedule_task", {
        title: "webhook",
        description: "fire webhook",
        schedule: "0 9 * * *",
        action_type: "message",
        action_payload: JSON.stringify({ webhook: "https://example.com/hook" }),
      }),
    ).toBe("HIGH_STAKES_WRITE");
  });

  it("schedule_task with non-message action_type stays HIGH", () => {
    expect(
      classifyToolCall("schedule_task", {
        title: "run code daily",
        description: "run something",
        schedule: "0 9 * * *",
        action_type: "code",
        action_payload: "{}",
      }),
    ).toBe("HIGH_STAKES_WRITE");
  });

  it("schedule_task with malformed payload stays HIGH (fail-safe)", () => {
    expect(
      classifyToolCall("schedule_task", {
        title: "x",
        description: "x",
        schedule: "0 9 * * *",
        action_type: "message",
        action_payload: "not-json-at-all",
      }),
    ).toBe("HIGH_STAKES_WRITE");
  });

  it("falls back to classifyTool when input is null/not-an-object", () => {
    expect(classifyToolCall("send_new_email", null)).toBe("HIGH_STAKES_WRITE");
    expect(classifyToolCall("send_new_email", undefined)).toBe("HIGH_STAKES_WRITE");
    expect(classifyToolCall("send_new_email", "string-input")).toBe("HIGH_STAKES_WRITE");
    expect(classifyToolCall("luca_run_code", null)).toBe("READ_ONLY");
  });
});

describe("classify: admissible vs unadmitted invariants", () => {
  it("no tool is simultaneously admissible and unadmitted", () => {
    for (const name of Object.keys(TOOL_WRITE_CLASS)) {
      expect(UNADMITTED_TOOLS.has(name), `${name} is classified AND marked unadmitted`).toBe(
        false,
      );
    }
  });

  it("UNADMITTED_TOOLS contains known phantom/legacy tools", () => {
    // Sanity: the main culprits from the W7 P2.5 trim must stay out.
    expect(UNADMITTED_TOOLS.has("composio_action")).toBe(true);
    expect(UNADMITTED_TOOLS.has("sandbox_shell")).toBe(true);
    expect(UNADMITTED_TOOLS.has("delegate_task")).toBe(true);
    expect(UNADMITTED_TOOLS.has("build_project")).toBe(true);
    // Phantoms (no luca_ prefix) must stay out.
    expect(UNADMITTED_TOOLS.has("run_code")).toBe(true);
    expect(UNADMITTED_TOOLS.has("web_search")).toBe(true);
    expect(UNADMITTED_TOOLS.has("read_url")).toBe(true);
    expect(UNADMITTED_TOOLS.has("analyze_image")).toBe(true);
  });

  it("send_telegram_message is HIGH by name (LEO PR-A; tiered downgrade in classifyToolCall)", () => {
    expect(TOOL_WRITE_CLASS.send_telegram_message).toBe("HIGH_STAKES_WRITE");
  });

  it("admissible tool set matches LucaAdmissibleTool type (compile-time via satisfies)", () => {
    // This test is a runtime smoke: table has the declared keys. The real
    // exhaustiveness check is `satisfies Record<LucaAdmissibleTool, ...>`
    // in classify.ts — if types drift, tsc fails before this runs.
    const keys = new Set(Object.keys(TOOL_WRITE_CLASS));
    const expectedV1a: LucaAdmissibleTool[] = [
      "luca_run_code",
      "luca_analyze_image",
      "luca_search",
      "luca_read_url",
    ];
    for (const k of expectedV1a) {
      expect(keys.has(k), `missing ${k}`).toBe(true);
    }
  });
});

describe("classify: send_telegram_message tiered gating (LEO PR-A)", () => {
  it("HIGH by name (fail-closed default)", () => {
    expect(TOOL_WRITE_CLASS.send_telegram_message).toBe("HIGH_STAKES_WRITE");
  });

  it("urgency='high' downgrades to LOW (bypasses gate)", () => {
    expect(
      classifyToolCall("send_telegram_message", { text: "hi", urgency: "high" }),
    ).toBe("LOW_STAKES_WRITE");
  });

  it("urgency='normal' stays HIGH (gate intercepts → BOSS approves)", () => {
    expect(
      classifyToolCall("send_telegram_message", { text: "hi", urgency: "normal" }),
    ).toBe("HIGH_STAKES_WRITE");
  });

  it("urgency='low' stays HIGH (caller should suppress earlier; gate is backstop)", () => {
    expect(
      classifyToolCall("send_telegram_message", { text: "hi", urgency: "low" }),
    ).toBe("HIGH_STAKES_WRITE");
  });

  it("missing/invalid urgency stays HIGH (fail-closed)", () => {
    expect(classifyToolCall("send_telegram_message", { text: "hi" })).toBe(
      "HIGH_STAKES_WRITE",
    );
    expect(
      classifyToolCall("send_telegram_message", { text: "hi", urgency: "??" }),
    ).toBe("HIGH_STAKES_WRITE");
    expect(
      classifyToolCall("send_telegram_message", { text: "hi", urgency: 7 }),
    ).toBe("HIGH_STAKES_WRITE");
  });
});
