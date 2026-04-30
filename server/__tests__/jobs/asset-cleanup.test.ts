/**
 * PR-A.6 — server/lib/jobs/asset-cleanup.ts unit tests.
 *
 * Covers:
 *   - happy path: deletes binary then marks attachment expired
 *   - workspace disabled => skip with skippedDisabled=true
 *   - mark-expired failure after delete bumps `failed`
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../storage", () => ({
  storage: {
    listExpiredAttachments: vi.fn(),
    markAttachmentExpired: vi.fn(),
  },
}));

const mockWorkspace = vi.hoisted(() => ({
  workspaceEnabled: true,
  deleteAssetByKey: vi.fn(),
}));
vi.mock("../../workspace-storage", () => mockWorkspace);

import { runAssetCleanup, ASSET_CLEANUP_JOB_ID } from "../../lib/jobs/asset-cleanup";
import { storage } from "../../storage";

describe("asset-cleanup", () => {
  beforeEach(() => {
    (storage.listExpiredAttachments as any).mockReset();
    (storage.markAttachmentExpired as any).mockReset();
    mockWorkspace.deleteAssetByKey.mockReset();
    mockWorkspace.workspaceEnabled = true;
  });

  it("deletes binary then marks attachment expired (happy path)", async () => {
    (storage.listExpiredAttachments as any).mockResolvedValue([
      { messageId: 1, attachmentId: "att_a", storageKey: "k1" },
      { messageId: 2, attachmentId: "att_b", storageKey: "k2" },
    ]);
    mockWorkspace.deleteAssetByKey.mockResolvedValue(true);
    (storage.markAttachmentExpired as any).mockResolvedValue(undefined);

    const out = await runAssetCleanup(Date.now());
    expect(out.scanned).toBe(2);
    expect(out.deleted).toBe(2);
    expect(out.failed).toBe(0);
    expect(out.skippedDisabled).toBe(false);
    expect(mockWorkspace.deleteAssetByKey).toHaveBeenCalledTimes(2);
    expect(storage.markAttachmentExpired).toHaveBeenCalledTimes(2);
  });

  it("returns skippedDisabled=true when workspace storage is disabled", async () => {
    mockWorkspace.workspaceEnabled = false;
    const out = await runAssetCleanup(Date.now());
    expect(out.skippedDisabled).toBe(true);
    expect(storage.listExpiredAttachments).not.toHaveBeenCalled();
  });

  it("counts a markAttachmentExpired failure as `failed`", async () => {
    (storage.listExpiredAttachments as any).mockResolvedValue([
      { messageId: 1, attachmentId: "att_a", storageKey: "k1" },
    ]);
    mockWorkspace.deleteAssetByKey.mockResolvedValue(true);
    (storage.markAttachmentExpired as any).mockRejectedValue(new Error("db down"));
    const out = await runAssetCleanup(Date.now());
    expect(out.deleted).toBe(0);
    expect(out.failed).toBe(1);
  });

  it("exports stable job id", () => {
    expect(ASSET_CLEANUP_JOB_ID).toBe("attachment-pii-cleanup");
  });
});
