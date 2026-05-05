/**
 * R473 — fabrication probe context contract
 *
 * Probes run inside the hidden `__kioku_self_test__` room. They MUST be
 * routed through the same partner-chat pipeline as user-facing chat so
 * that:
 *   - partner tools (luca_search, luca_read_url, luca_analyze_image, …)
 *     are actually attached to Luca's request, and
 *   - the anti-fabrication system-prompt sections (R471 reading honesty
 *     rule, etc.) reach Luca.
 *
 * Pre-R473, isPartnerChat was strictly `roomName === "Partner"`, which
 * stripped tools and prompt rules from probes — making every probe
 * falsely fail on its own internal contract.
 */

import { describe, it, expect } from "vitest";
import { isPartnerChatRoomName } from "../../deliberation";

describe("R473: isPartnerChatRoomName", () => {
  it("treats the user-facing Partner room as partner chat", () => {
    expect(isPartnerChatRoomName("Partner")).toBe(true);
  });

  it("treats the hidden self-monitoring probe room as partner chat", () => {
    expect(isPartnerChatRoomName("__kioku_self_test__")).toBe(true);
  });

  it("rejects arbitrary room names", () => {
    expect(isPartnerChatRoomName("General")).toBe(false);
    expect(isPartnerChatRoomName("partner")).toBe(false); // case-sensitive
    expect(isPartnerChatRoomName("")).toBe(false);
    expect(isPartnerChatRoomName(undefined)).toBe(false);
  });
});
