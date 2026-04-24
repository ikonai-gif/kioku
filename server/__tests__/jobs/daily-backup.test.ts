/**
 * Tests for lib/jobs/daily-backup.ts — validation, filename, upload orchestration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateDump,
  dumpUserForBackup,
  runDailyBackup,
  DAILY_BACKUP_JOB_ID,
  type BackupDump,
} from "../../lib/jobs/daily-backup";

function goodDump(overrides: Partial<BackupDump> = {}): BackupDump {
  const base: BackupDump = {
    meta: {
      dumpedAt: "2026-04-24T13:00:00Z",
      dumpedAtMs: 1,
      userId: 10,
      includeEmbeddings: false,
      version: 1,
    },
    user: { id: 10, email: "kotkave@gmail.com" },
    counts: { agents: 3, memories: 500, rooms: 2, room_messages: 100, flows: 0, integrations: 1 },
    agents: [],
    memories: [],
    rooms: [],
    room_messages: [],
    flows: [],
    integrations_meta: [],
  };
  return { ...base, ...overrides, user: { ...base.user, ...(overrides.user ?? {}) } };
}

describe("daily-backup · validateDump", () => {
  it("passes on a healthy dump", () => {
    const d = goodDump();
    const r = validateDump(d, 200_000, "kotkave@gmail.com");
    expect(r.ok).toBe(true);
  });

  it("fails when bytes below minimum", () => {
    const d = goodDump();
    const r = validateDump(d, 1024, "kotkave@gmail.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_small");
  });

  it("fails when email does not match when expectedEmail is set", () => {
    const d = goodDump({ user: { id: 10, email: "attacker@evil.com" } });
    const r = validateDump(d, 200_000, "kotkave@gmail.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("email_mismatch");
  });

  it("skips email check when expectedEmail is undefined", () => {
    const d = goodDump({ user: { id: 10, email: "whoever@example.com" } });
    const r = validateDump(d, 200_000, undefined);
    expect(r.ok).toBe(true);
  });

  it("fails on zero memories", () => {
    const d = goodDump({
      counts: { agents: 0, memories: 0, rooms: 0, room_messages: 0, flows: 0, integrations: 0 },
    });
    const r = validateDump(d, 200_000, "kotkave@gmail.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty_memories");
  });
});

describe("daily-backup · dumpUserForBackup", () => {
  it("runs 7 SELECTs and assembles counts correctly", async () => {
    const sqls: string[] = [];
    const fakePool = {
      query: async (sql: string, _args: any[]) => {
        sqls.push(sql);
        if (/FROM users/i.test(sql)) {
          return {
            rows: [
              {
                id: 10,
                email: "kotkave@gmail.com",
                name: "Kote",
                role: "user",
                plan: "free",
                created_at: "2025-01-01",
              },
            ],
          };
        }
        if (/FROM agents/i.test(sql)) return { rows: [{}, {}, {}] };
        if (/FROM memories/i.test(sql)) return { rows: new Array(500).fill({}) };
        if (/FROM rooms/i.test(sql) && !/JOIN/i.test(sql)) return { rows: [{}, {}] };
        if (/room_messages/i.test(sql)) return { rows: new Array(100).fill({}) };
        if (/FROM flows/i.test(sql)) return { rows: [] };
        if (/FROM user_integrations/i.test(sql)) return { rows: [{}] };
        throw new Error("unexpected SQL: " + sql);
      },
    };
    const d = await dumpUserForBackup(10, fakePool as any);
    expect(d.user.email).toBe("kotkave@gmail.com");
    expect(d.counts.memories).toBe(500);
    expect(d.counts.agents).toBe(3);
    expect(d.counts.integrations).toBe(1);
    // By default embeddings are stripped → the memory SELECT uses explicit column list.
    const memSql = sqls.find((s) => /FROM memories/i.test(s));
    expect(memSql).toBeDefined();
    expect(memSql!.includes("*")).toBe(false);
    expect(memSql!).toContain("importance");
  });

  it("throws if user does not exist", async () => {
    const fakePool = {
      query: async (sql: string) => {
        if (/FROM users/i.test(sql)) return { rows: [] };
        return { rows: [] };
      },
    };
    await expect(dumpUserForBackup(99, fakePool as any)).rejects.toThrow(/not found/);
  });
});

describe("daily-backup · runDailyBackup", () => {
  const ENV_KEYS = ["BACKUP_USER_ID", "BACKUP_EXPECTED_EMAIL", "BACKUP_MIN_BYTES"];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.BACKUP_USER_ID = "10";
    process.env.BACKUP_EXPECTED_EMAIL = "kotkave@gmail.com";
    process.env.BACKUP_MIN_BYTES = "1000"; // low so our test dump passes
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k] as string;
    }
  });

  function poolForDump(dump: BackupDump) {
    return {
      query: async (sql: string) => {
        if (/FROM users/i.test(sql)) return { rows: [dump.user] };
        if (/FROM agents/i.test(sql)) return { rows: dump.agents };
        if (/FROM memories/i.test(sql)) {
          // Return rows that match the dump's stated memory count, each with
          // enough content to push the serialized dump well above 1000 bytes.
          const rows = dump.memories.length
            ? dump.memories
            : new Array(dump.counts.memories).fill({ id: 1, content: "x".repeat(200) });
          return { rows };
        }
        if (/FROM rooms/i.test(sql) && !/JOIN/i.test(sql)) return { rows: dump.rooms };
        if (/room_messages/i.test(sql)) return { rows: dump.room_messages };
        if (/FROM flows/i.test(sql)) return { rows: dump.flows };
        if (/FROM user_integrations/i.test(sql)) return { rows: dump.integrations_meta };
        throw new Error("unexpected SQL in backup test: " + sql);
      },
    } as any;
  }

  it("happy path: dumps, validates, uploads, returns detail", async () => {
    // Pad memories to make the dump > 1000 bytes after JSON serialization.
    const dump = goodDump({
      memories: new Array(50).fill({ id: 1, content: "x".repeat(200) }),
      counts: { agents: 0, memories: 50, rooms: 0, room_messages: 0, flows: 0, integrations: 0 },
    });
    const uploads: any[] = [];
    const driveMock = {
      files: {
        create: async (req: any) => {
          uploads.push(req);
          return { data: { id: "drive-abc123", name: req.requestBody.name, size: "999", webViewLink: "https://drive/abc" } };
        },
      },
    };
    const notified: any[] = [];
    // Inject Drive config so the uploader doesn't insist on env vars.
    process.env.GOOGLE_DRIVE_CLIENT_ID = "cid";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "sec";
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = "rt";
    process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID = "fid";

    const result = await runDailyBackup({
      poolOverride: poolForDump(dump),
      driveOverride: driveMock,
      notify: async (p) => {
        notified.push(p);
        return { delivered: true, status: 204 };
      },
      now: new Date(Date.UTC(2026, 3, 24, 13, 0)),
    });
    expect(notified).toHaveLength(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].requestBody.name).toBe("kioku-id10-2026-04-24.json");
    expect(uploads[0].requestBody.parents).toEqual(["fid"]);
    expect(result.drive_file_id).toBe("drive-abc123");
    expect(result.filename).toBe("kioku-id10-2026-04-24.json");
    expect((result.dump_counts as any).memories).toBe(50);
  });

  it("alerts + throws on email-mismatch", async () => {
    const dump = goodDump({
      user: { id: 10, email: "wrong@example.com" },
      memories: new Array(100).fill({ id: 1, content: "x".repeat(200) }),
      counts: { agents: 0, memories: 100, rooms: 0, room_messages: 0, flows: 0, integrations: 0 },
    });
    const notified: any[] = [];
    const driveMock = {
      files: {
        create: async () => {
          throw new Error("should not upload on validation fail");
        },
      },
    };

    await expect(
      runDailyBackup({
        poolOverride: poolForDump(dump),
        driveOverride: driveMock,
        notify: async (p) => {
          notified.push(p);
          return { delivered: true, status: 204 };
        },
      }),
    ).rejects.toThrow(/email_mismatch/);
    expect(notified).toHaveLength(1);
    expect(notified[0].severity).toBe("critical");
    expect(notified[0].title).toMatch(/validation failed/);
  });

  it("alerts + throws when Drive upload fails", async () => {
    const dump = goodDump({
      memories: new Array(100).fill({ id: 1, content: "x".repeat(200) }),
      counts: { agents: 0, memories: 100, rooms: 0, room_messages: 0, flows: 0, integrations: 0 },
    });
    const driveMock = {
      files: {
        create: async () => {
          throw new Error("drive HTTP 500");
        },
      },
    };
    const notified: any[] = [];
    await expect(
      runDailyBackup({
        poolOverride: poolForDump(dump),
        driveOverride: driveMock,
        notify: async (p) => {
          notified.push(p);
          return { delivered: true, status: 204 };
        },
      }),
    ).rejects.toThrow(/drive HTTP 500/);
    expect(notified).toHaveLength(1);
    expect(notified[0].title).toMatch(/Drive upload failed/);
  });

  it("throws if BACKUP_USER_ID env missing", async () => {
    delete process.env.BACKUP_USER_ID;
    await expect(runDailyBackup({ notify: async () => ({ delivered: true, status: 204 }) })).rejects.toThrow(
      /BACKUP_USER_ID/,
    );
  });

  it("exports job id constant", () => {
    expect(DAILY_BACKUP_JOB_ID).toBe("daily-user-backup");
  });
});
