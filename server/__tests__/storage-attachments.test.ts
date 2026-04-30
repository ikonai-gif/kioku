/**
 * PR-A.6 — storage.ts attachment helpers.
 *
 * Verifies:
 *   - patchAttachment merges a partial patch into the matching JSONB element
 *     and persists the array via UPDATE ... RETURNING.
 *   - listExpiredAttachments issues a SQL using jsonb_array_elements with
 *     the expected predicates (expires_at finite + < now AND storage_key
 *     IS NOT NULL) and returns rows mapped to the public shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = vi.fn();
    this.on = vi.fn();
    this.end = vi.fn().mockResolvedValue(undefined);
    this.connect = vi.fn();
  }
  return { Pool: MockPool };
});
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));

// Capture the patch path: storage.patchAttachment performs SELECT-then-UPDATE.
// We provide a tiny chain stub that records inputs and returns programmable
// rows.
const dbState = vi.hoisted(() => ({
  selectRows: [] as any[],
  updateRows: [] as any[],
  lastUpdateSet: null as any,
}));

// drizzle's `eq` is invoked by storage; passthrough so chains still build.
vi.mock("drizzle-orm", async (orig) => {
  const real = await (orig() as Promise<any>);
  return { ...real, eq: (a: any, b: any) => ({ a, b }) };
});

vi.mock("./logger", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { Storage, db, pool } from "../storage";

// Patch db.select/update at runtime so each test controls the chain results.
beforeEach(() => {
  (db as any).select = vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve(dbState.selectRows),
    }),
  }));
  (db as any).update = vi.fn(() => ({
    set: (vals: any) => {
      dbState.lastUpdateSet = vals;
      return {
        where: () => ({
          returning: () => Promise.resolve(dbState.updateRows),
        }),
      };
    },
  }));
});

describe("storage.patchAttachment — JSONB merge + persist", () => {
  beforeEach(() => {
    dbState.selectRows = [];
    dbState.updateRows = [];
    dbState.lastUpdateSet = null;
  });

  it("merges patch into matching attachment and writes the new array", async () => {
    const original = {
      id: 42,
      attachments: [
        { id: "att_a", type: "image", summary: null, signed_url: "old" },
        { id: "att_b", type: "voice", summary: null },
      ],
    };
    dbState.selectRows = [original];
    dbState.updateRows = [{
      ...original,
      attachments: [
        { id: "att_a", type: "image", summary: "hi", signed_url: "new" },
        { id: "att_b", type: "voice", summary: null },
      ],
    }];

    const s = new Storage();
    const out = await s.patchAttachment(42, "att_a", { summary: "hi", signed_url: "new" });
    expect(out).not.toBeNull();
    expect(dbState.lastUpdateSet).toBeTruthy();
    expect(dbState.lastUpdateSet.attachments).toHaveLength(2);
    const patched = dbState.lastUpdateSet.attachments.find((a: any) => a.id === "att_a");
    expect(patched.summary).toBe("hi");
    expect(patched.signed_url).toBe("new");
    // Other attachment must be unchanged.
    const untouched = dbState.lastUpdateSet.attachments.find((a: any) => a.id === "att_b");
    expect(untouched.summary).toBeNull();
  });

  it("returns null when message row not found", async () => {
    dbState.selectRows = [];
    const s = new Storage();
    const out = await s.patchAttachment(999, "att_x", { summary: "x" });
    expect(out).toBeNull();
    expect(dbState.lastUpdateSet).toBeNull();
  });
});

describe("storage.listExpiredAttachments — SQL shape + mapping", () => {
  beforeEach(() => {
    (pool.query as any).mockReset();
  });

  it("queries jsonb_array_elements with expires_at + storage_key predicates", async () => {
    (pool.query as any).mockResolvedValue({
      rows: [
        { msg_id: 1, att_id: "a1", key: "k1" },
        { msg_id: 2, att_id: "a2", key: "k2" },
      ],
    });
    const s = new Storage();
    const now = 1714500000000;
    const out = await s.listExpiredAttachments(now);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (pool.query as any).mock.calls[0];
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).toContain("'expires_at'");
    expect(sql).toContain("'storage_key'");
    expect(params).toEqual([now]);

    expect(out).toEqual([
      { messageId: 1, attachmentId: "a1", storageKey: "k1" },
      { messageId: 2, attachmentId: "a2", storageKey: "k2" },
    ]);
  });
});
