// R464 — luca_self_config unit tests.
//
// Acceptance criteria:
//   1) Snapshot shape includes all required top-level keys.
//   2) tool_flags reflect three-level effective gate (master ∧ tools-master ∧ per-tool).
//   3) secrets_present returns booleans only — never values, even when set.
//   4) studio_tools.expanded is null when expandedActive=false; populated when true.
//   5) studio_tools.effective is base when !expandedActive; base+expanded when expandedActive.
//   6) spec_version is the frozen literal "self_config@1".

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSelfConfigSnapshot } from "../../server/lib/luca-tools/self-config.js";

const ENV_KEYS = [
  "LUCA_V1A_ENABLED",
  "LUCA_TOOLS_ENABLED",
  "LUCA_TOOL_RUN_CODE_ENABLED",
  "LUCA_TOOL_ANALYZE_IMAGE_ENABLED",
  "LUCA_TOOL_SEARCH_ENABLED",
  "LUCA_TOOL_READ_URL_ENABLED",
  "LUCA_TOOL_AGENT_BROWSER_ENABLED",
  "LUCA_TOOL_READ_MEMORY_ENABLED",
  "LUCA_TOOL_WRITE_MEMORY_ENABLED",
  "LUCA_TOOL_READ_FILE_ENABLED",
  "LUCA_TOOL_UPLOAD_FILE_ENABLED",
  "LUCA_EMAIL_SCOPE_ENABLED",
  "LUCA_TOOL_EMAIL_READ_ENABLED",
  "LUCA_APPROVAL_GATE_ENABLED",
  "LUCA_APPROVAL_GATE_MODE",
  "LUCA_EXPANDED_SCOPE_ENABLED",
  "LUCA_PROMPT_CACHING_ENABLED",
  "BRAVE_SEARCH_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOSS_CHAT_ID",
  "LUCA_S3_BUCKET",
  "LUCA_DRIVE_ROOT_FOLDER",
  "AWS_REGION",
] as const;

function snapshotEnv() {
  const orig: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) orig[k] = process.env[k];
  return orig;
}
function restoreEnv(orig: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (orig[k] === undefined) delete process.env[k];
    else process.env[k] = orig[k];
  }
}

describe("R464 / luca_self_config — snapshot shape & semantics", () => {
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = snapshotEnv();
    // Clean slate: remove every env var we touch.
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it("returns a snapshot with the frozen v1 keys + spec_version='self_config@1'", () => {
    const snap = buildSelfConfigSnapshot({
      baseToolNames: ["t_a", "t_b"],
      expandedToolNames: ["t_c"],
      expandedActive: false,
    });
    expect(snap.spec_version).toBe("self_config@1");
    expect(Object.keys(snap).sort()).toEqual(
      ["master_flags", "quiet_hours", "secrets_present", "spec_version", "studio_tools", "tool_flags"].sort(),
    );
    expect(snap.master_flags).toBeTruthy();
    expect(snap.tool_flags).toBeTruthy();
    expect(snap.secrets_present).toBeTruthy();
    expect(snap.studio_tools).toBeTruthy();
  });

  it("tool_flags=false when master OFF, even if per-tool flag is ON", () => {
    process.env.LUCA_V1A_ENABLED = "false";
    process.env.LUCA_TOOLS_ENABLED = "true";
    process.env.LUCA_TOOL_RUN_CODE_ENABLED = "true";
    const snap = buildSelfConfigSnapshot({
      baseToolNames: [], expandedToolNames: [], expandedActive: false,
    });
    expect(snap.tool_flags.LUCA_TOOL_RUN_CODE_ENABLED).toBe(false);
  });

  it("tool_flags=false when tools-master OFF, even if master + per-tool ON", () => {
    process.env.LUCA_V1A_ENABLED = "true";
    process.env.LUCA_TOOLS_ENABLED = "false";
    process.env.LUCA_TOOL_RUN_CODE_ENABLED = "true";
    const snap = buildSelfConfigSnapshot({
      baseToolNames: [], expandedToolNames: [], expandedActive: false,
    });
    expect(snap.tool_flags.LUCA_TOOL_RUN_CODE_ENABLED).toBe(false);
  });

  it("tool_flags=true only when ALL three levels ON", () => {
    process.env.LUCA_V1A_ENABLED = "true";
    process.env.LUCA_TOOLS_ENABLED = "true";
    process.env.LUCA_TOOL_SEARCH_ENABLED = "true";
    process.env.LUCA_TOOL_RUN_CODE_ENABLED = "false";
    const snap = buildSelfConfigSnapshot({
      baseToolNames: [], expandedToolNames: [], expandedActive: false,
    });
    expect(snap.tool_flags.LUCA_TOOL_SEARCH_ENABLED).toBe(true);
    expect(snap.tool_flags.LUCA_TOOL_RUN_CODE_ENABLED).toBe(false);
  });

  it("email tool requires the four-level gate (adds LUCA_EMAIL_SCOPE_ENABLED)", () => {
    process.env.LUCA_V1A_ENABLED = "true";
    process.env.LUCA_TOOLS_ENABLED = "true";
    process.env.LUCA_TOOL_EMAIL_READ_ENABLED = "true";
    // Without scope flag → false.
    process.env.LUCA_EMAIL_SCOPE_ENABLED = "false";
    let snap = buildSelfConfigSnapshot({
      baseToolNames: [], expandedToolNames: [], expandedActive: false,
    });
    expect(snap.tool_flags.LUCA_TOOL_EMAIL_READ_ENABLED).toBe(false);
    // With scope flag → true.
    process.env.LUCA_EMAIL_SCOPE_ENABLED = "true";
    snap = buildSelfConfigSnapshot({
      baseToolNames: [], expandedToolNames: [], expandedActive: false,
    });
    expect(snap.tool_flags.LUCA_TOOL_EMAIL_READ_ENABLED).toBe(true);
  });

  it("secrets_present returns BOOLEANS — never the actual secret value", () => {
    const SECRET = "sk-this-must-never-leak-1234567890";
    process.env.BRAVE_SEARCH_API_KEY = SECRET;
    process.env.TELEGRAM_BOT_TOKEN = "";       // empty → false
    delete process.env.TELEGRAM_BOSS_CHAT_ID;  // missing → false
    const snap = buildSelfConfigSnapshot({
      baseToolNames: [], expandedToolNames: [], expandedActive: false,
    });
    expect(snap.secrets_present.BRAVE_SEARCH_API_KEY).toBe(true);
    expect(snap.secrets_present.TELEGRAM_BOT_TOKEN).toBe(false);
    expect(snap.secrets_present.TELEGRAM_BOSS_CHAT_ID).toBe(false);
    // Defense-in-depth: the secret string MUST NOT appear anywhere in the
    // serialized snapshot. This is the property check that makes this tool
    // safe to surface to Luca's prompt.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(SECRET);
  });

  it("studio_tools.expanded is null when expandedActive=false; effective = base only", () => {
    const snap = buildSelfConfigSnapshot({
      baseToolNames: ["a", "b"],
      expandedToolNames: ["c", "d"],
      expandedActive: false,
    });
    expect(snap.studio_tools.expanded).toBeNull();
    expect(Array.from(snap.studio_tools.effective)).toEqual(["a", "b"]);
  });

  it("studio_tools.expanded populated when expandedActive=true; effective = union", () => {
    const snap = buildSelfConfigSnapshot({
      baseToolNames: ["a", "b"],
      expandedToolNames: ["c", "d"],
      expandedActive: true,
    });
    expect(snap.studio_tools.expanded).toEqual(["c", "d"]);
    expect(Array.from(snap.studio_tools.effective)).toEqual(["a", "b", "c", "d"]);
  });

  it("master_flags reflect raw env booleans (not effective gates)", () => {
    process.env.LUCA_V1A_ENABLED = "true";
    process.env.LUCA_TOOLS_ENABLED = "false";
    process.env.LUCA_APPROVAL_GATE_ENABLED = "true";
    // Mode default is "block" — force "log_only".
    process.env.LUCA_APPROVAL_GATE_MODE = "log_only";
    const snap = buildSelfConfigSnapshot({
      baseToolNames: [], expandedToolNames: [], expandedActive: false,
    });
    expect(snap.master_flags.LUCA_V1A_ENABLED).toBe(true);
    expect(snap.master_flags.LUCA_TOOLS_ENABLED).toBe(false);
    expect(snap.master_flags.LUCA_APPROVAL_GATE_ENABLED).toBe(true);
    expect(snap.master_flags.LUCA_APPROVAL_GATE_MODE).toBe("log_only");
  });

  it("quiet_hours falls back to defaults when env unset", () => {
    delete process.env.LUCA_QUIET_HOURS;
    delete process.env.LUCA_QUIET_HOURS_TZ;
    const snap = buildSelfConfigSnapshot({
      baseToolNames: [], expandedToolNames: [], expandedActive: false,
    });
    expect(snap.quiet_hours.window).toBe("22:00-08:00");
    expect(snap.quiet_hours.tz).toBe("America/Los_Angeles");
  });
});
