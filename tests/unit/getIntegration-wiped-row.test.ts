/**
 * LUCA-047 — getIntegration must ignore wiped / dead integration rows.
 *
 * getIntegration is private; exercised via getGoogleToken → searchGoogleDrive.
 * pool.query is mocked — no real DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPoolQuery } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
}));

vi.mock("../../server/storage", () => ({
  pool: { query: mockPoolQuery },
  storage: {},
}));

import { searchGoogleDrive } from "../../server/cloud-integrations";

const USER_ID = 42;
const FUTURE_EXPIRY = Date.now() + 3_600_000;

function integrationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    access_token: "valid-access-token",
    refresh_token: "refresh",
    token_expiry: FUTURE_EXPIRY,
    email: "user@example.com",
    provider: "google_drive",
    ...overrides,
  };
}

describe("getIntegration — wiped / stale row handling", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ files: [] }),
        text: async () => "{}",
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a live integration when a valid row exists", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [integrationRow()] });

    await expect(searchGoogleDrive(USER_ID, "report")).resolves.toEqual([]);

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM user_integrations"),
      [USER_ID, "google_drive"],
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("googleapis.com/drive"),
      expect.objectContaining({
        headers: { Authorization: "Bearer valid-access-token" },
      }),
    );
  });

  it("returns null when access_token is empty (wiped row)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [integrationRow({ access_token: "" })],
    });

    await expect(searchGoogleDrive(USER_ID, "q")).rejects.toThrow(
      "Google Drive not connected",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null when token is expired and refresh_token is null", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        integrationRow({
          token_expiry: Date.now() - 60_000,
          refresh_token: null,
        }),
      ],
    });

    await expect(searchGoogleDrive(USER_ID, "q")).rejects.toThrow(
      "Google Drive not connected",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null when no row is found", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(searchGoogleDrive(USER_ID, "q")).rejects.toThrow(
      "Google Drive not connected",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the newest row when duplicates exist (ORDER BY updated_at DESC, LIMIT 1)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        integrationRow({
          id: 99,
          access_token: "newer-token",
          updated_at: Date.now(),
        }),
      ],
    });

    await searchGoogleDrive(USER_ID, "q");

    const [sql] = mockPoolQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY updated_at DESC NULLS LAST, id DESC/i);
    expect(sql).toMatch(/LIMIT 1/i);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer newer-token" },
      }),
    );
  });
});
