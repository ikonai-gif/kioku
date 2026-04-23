/**
 * Luca Day 6 — gate.ts unit tests.
 *
 * Strategy: we don't have a live test Postgres for these tests, and
 * drizzle's query builder is too rich to mock shallowly. We inject
 * an in-memory fake db via __setGateDbForTests that implements the
 * subset of the drizzle interface gate.ts actually uses:
 *   - db.insert(table).values(row).returning()
 *   - db.update(table).set(patch).where(cond).returning()
 *   - db.select([proj]).from(table).where(cond).orderBy(x).limit(n)
 *
 * We don't replicate drizzle's condition language — instead we
 * interpret a small DSL where each call to `.where(expr)` receives
 * a synthetic object we built via intercepting drizzle's eq/and/...
 * helpers through capturing the arguments. But this is fragile.
 *
 * Simpler approach: we don't care WHAT drizzle condition expression
 * was composed — we only care that the gate's LOGIC is right. So
 * the fake db ignores conditions entirely and lets the caller (this
 * test file) plant rows directly and assert on the side-effects of
 * gate functions. We verify gate behavior end-to-end via its return
 * values, not via inspecting SQL.
 *
 * This means these tests are behavioral unit tests: they call the
 * gate, the fake db records ops, and we make assertions about
 * what the gate returned and what it wrote to the fake store.
 * Condition correctness is covered by integration/prod — for this
 * level, we specifically test:
 *   - dedupe logic (same-turn retry reuses row)
 *   - decide state transitions
 *   - expirePending predicate (manually filtered in the fake)
 *   - authorization on decide
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setGateDbForTests,
  __resetGateDbForTests,
  ApprovalError,
  DEFAULT_APPROVAL_TTL_MS,
  SOLO_DEDUPE_WINDOW_MS,
  computeCodeSha,
  countPendingForUser,
  createPendingApproval,
  decideApproval,
  expirePending,
  getApproval,
  listPendingForUser,
  recordExecutionResult,
  stableStringify,
} from "../../lib/luca-approvals/gate";
import type { ToolApproval } from "@shared/schema";

/**
 * In-memory fake that implements just enough of the drizzle surface.
 *
 * Strategy: the fake records each high-level operation and answers
 * reads based on filters we apply by re-running the gate's internal
 * predicate in TypeScript. Rather than interpret drizzle conditions,
 * we expose pluggable "query matchers" — test configures what rows
 * come back for a SELECT and what UPDATE does.
 *
 * For THIS test file, we take an even simpler route: the fake holds
 * a single table `rows: ToolApproval[]` and answers all queries via
 * a filter callback planted by each test. Because gate.ts always
 * calls db.select().from(toolApprovals)... we don't need to know
 * which table — there's only one.
 */
class FakeDb {
  rows: ToolApproval[] = [];
  // Filter applied on the next select() call. Test sets this to
  // simulate "what rows match the query gate composed".
  nextSelectFilter: ((row: ToolApproval) => boolean) | null = null;
  // Optional order: if set, sort matched rows by this comparator before limit.
  nextSelectSort: ((a: ToolApproval, b: ToolApproval) => number) | null = null;

  insert(_table: unknown) {
    return {
      values: (row: Omit<ToolApproval, "id" | "createdAt"> & {
        createdAt?: Date;
        id?: string;
      }) => ({
        returning: async () => {
          const stamped: ToolApproval = {
            ...(row as ToolApproval),
            id: row.id ?? `uuid-${this.rows.length + 1}`,
            createdAt: row.createdAt ?? new Date(),
          };
          this.rows.push(stamped);
          return [stamped];
        },
      }),
    };
  }

  update(_table: unknown) {
    // update() supports two shapes used by gate.ts:
    //   .update(t).set(patch).where(cond).returning()       — decide/record
    //   .update(t).set(patch).where(cond).returning() with multiple matches — expirePending
    const self = this;
    return {
      set: (patch: Partial<ToolApproval>) => ({
        where: (_cond: unknown) => ({
          returning: async () => {
            const filter = self.nextSelectFilter ?? (() => false);
            self.nextSelectFilter = null;
            const updated: ToolApproval[] = [];
            for (const row of self.rows) {
              if (filter(row)) {
                Object.assign(row, patch);
                updated.push(row);
              }
            }
            return updated;
          },
        }),
      }),
    };
  }

  select(_proj?: unknown) {
    const self = this;
    // The chain is .from(t).where(cond).orderBy(x).limit(n) OR
    //              .from(t).where(cond) (for count()-like queries).
    // Fake it all.
    const builder = {
      from: (_t: unknown) => builder,
      where: (_cond: unknown) => builder,
      orderBy: (_o: unknown) => builder,
      limit: async (n: number) => {
        // Default: NO match. Tests must plant a filter per SELECT they
        // expect to return rows for. This keeps dedupe lookups (which
        // gate.ts performs before every INSERT) from accidentally
        // matching prior rows in the fake store.
        const filter = self.nextSelectFilter ?? (() => false);
        self.nextSelectFilter = null;
        const sort = self.nextSelectSort;
        self.nextSelectSort = null;
        const matched = self.rows.filter(filter);
        if (sort) matched.sort(sort);
        return matched.slice(0, n);
      },
    };
    // Make the builder also thenable-on-where (for no .limit() count queries)
    // We return a Proxy-lite: the `where` chain can also resolve when awaited.
    // But gate.countPendingForUser uses `.select({count}).from(t).where(c)` — no limit.
    // Simulate that by making `where` return a builder that is both chainable AND awaitable.
    const awaitableBuilder: any = {
      from: (_t: unknown) => awaitableBuilder,
      where: (_cond: unknown) => awaitableBuilder,
      orderBy: (_o: unknown) => awaitableBuilder,
      limit: builder.limit,
      then: (resolve: any, reject: any) => {
        // Await w/o limit → used only by countPendingForUser. Returns
        // a one-row array with the count shape.
        try {
          const filter = self.nextSelectFilter ?? (() => false);
          self.nextSelectFilter = null;
          const count = self.rows.filter(filter).length;
          resolve([{ count }]);
        } catch (e) {
          reject(e);
        }
      },
    };
    return awaitableBuilder;
  }
}

let fake: FakeDb;

beforeEach(() => {
  fake = new FakeDb();
  __setGateDbForTests(fake);
});

afterEach(() => {
  __resetGateDbForTests();
});

// ─── stableStringify + computeCodeSha ─────────────────────────────

describe("gate: stableStringify + computeCodeSha", () => {
  it("stableStringify sorts object keys", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("stableStringify preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("stableStringify handles nested objects", () => {
    expect(stableStringify({ z: { b: 1, a: 2 }, y: [1, 2] })).toBe(
      '{"y":[1,2],"z":{"a":2,"b":1}}',
    );
  });

  it("stableStringify handles primitives and null", () => {
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
  });

  it("computeCodeSha is stable across key-order variations", () => {
    const a = computeCodeSha("send_new_email", { to: "x@y.z", subject: "hi" });
    const b = computeCodeSha("send_new_email", { subject: "hi", to: "x@y.z" });
    expect(a).toBe(b);
  });

  it("computeCodeSha differs across tools", () => {
    const a = computeCodeSha("send_new_email", { to: "x@y.z" });
    const b = computeCodeSha("send_email_reply", { to: "x@y.z" });
    expect(a).not.toBe(b);
  });

  it("computeCodeSha differs across payloads", () => {
    const a = computeCodeSha("send_new_email", { to: "x@y.z" });
    const b = computeCodeSha("send_new_email", { to: "a@b.c" });
    expect(a).not.toBe(b);
  });
});

// ─── createPendingApproval ────────────────────────────────────────

describe("gate: createPendingApproval", () => {
  const baseInput = {
    agentId: 16,
    userId: 10,
    meetingId: null,
    turnId: null,
    toolName: "send_new_email",
    draftPayload: { to: "alice@example.com", subject: "hi" },
  };

  it("inserts a pending row with status=pending and expires_at = +24h", async () => {
    const row = await createPendingApproval(baseInput);
    expect(row.status).toBe("pending");
    expect(row.toolName).toBe("send_new_email");
    expect(row.userId).toBe(10);
    expect(row.agentId).toBe(16);
    expect(row.codeSha).toBe(computeCodeSha(baseInput.toolName, baseInput.draftPayload));
    expect(row.finalPayload).toBeNull();
    expect(row.decidedAt).toBeNull();
    expect(row.executedAt).toBeNull();
    expect(row.draftPayload).toEqual(baseInput.draftPayload);
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    // Default is 24h = 86_400_000; allow 2s slack for test-time skew.
    expect(Math.abs(ttl - DEFAULT_APPROVAL_TTL_MS)).toBeLessThan(2000);
    expect(fake.rows.length).toBe(1);
  });

  it("dedupes identical calls within the same turn (turn-scoped — Luca N3)", async () => {
    const turnId = "11111111-1111-1111-1111-111111111111";
    const first = await createPendingApproval({ ...baseInput, turnId });

    // Simulate gate's dedupe lookup matching the first row.
    fake.nextSelectFilter = (r) =>
      r.agentId === baseInput.agentId &&
      r.toolName === baseInput.toolName &&
      r.codeSha === first.codeSha &&
      r.turnId === turnId &&
      r.status === "pending";

    const second = await createPendingApproval({ ...baseInput, turnId });
    expect(second.id).toBe(first.id);
    expect(fake.rows.length).toBe(1); // no new row inserted
  });

  it("does NOT dedupe across turns — different turnId creates new row", async () => {
    const turnA = "11111111-1111-1111-1111-111111111111";
    const turnB = "22222222-2222-2222-2222-222222222222";
    const first = await createPendingApproval({ ...baseInput, turnId: turnA });

    // Dedupe lookup for turn B finds no match (fake returns empty).
    fake.nextSelectFilter = (r) => r.turnId === turnB && r.status === "pending";
    const second = await createPendingApproval({ ...baseInput, turnId: turnB });
    expect(second.id).not.toBe(first.id);
    expect(fake.rows.length).toBe(2);
  });

  it("dedupes solo (turnId=null) within SOLO_DEDUPE_WINDOW_MS", async () => {
    const first = await createPendingApproval({ ...baseInput, turnId: null });

    // Simulate solo dedupe lookup matching first (within 60s).
    fake.nextSelectFilter = (r) =>
      r.agentId === baseInput.agentId &&
      r.toolName === baseInput.toolName &&
      r.codeSha === first.codeSha &&
      r.status === "pending" &&
      r.turnId === null;

    const second = await createPendingApproval({ ...baseInput, turnId: null });
    expect(second.id).toBe(first.id);
  });

  it("custom ttlMs respected", async () => {
    const row = await createPendingApproval({ ...baseInput, ttlMs: 60_000 });
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(Math.abs(ttl - 60_000)).toBeLessThan(2000);
  });

  it("different payloads produce different rows even within same turn", async () => {
    const turnId = "11111111-1111-1111-1111-111111111111";
    const a = await createPendingApproval({ ...baseInput, turnId });
    // Fake: no match for this sha.
    fake.nextSelectFilter = () => false;
    const b = await createPendingApproval({
      ...baseInput,
      turnId,
      draftPayload: { to: "bob@example.com", subject: "hi" },
    });
    expect(b.id).not.toBe(a.id);
    expect(b.codeSha).not.toBe(a.codeSha);
  });

  it("SOLO_DEDUPE_WINDOW_MS default is 60s", () => {
    expect(SOLO_DEDUPE_WINDOW_MS).toBe(60_000);
  });
});

// ─── decideApproval ───────────────────────────────────────────────

describe("gate: decideApproval", () => {
  const baseInput = {
    agentId: 16,
    userId: 10,
    meetingId: null,
    turnId: null,
    toolName: "send_new_email",
    draftPayload: { to: "alice@example.com", subject: "hi" },
  };

  async function seedPending() {
    const row = await createPendingApproval(baseInput);
    return row;
  }

  it("send → approved, final_payload=draft, shouldExecute=true", async () => {
    const row = await seedPending();
    // For getApproval: fake returns the row.
    fake.nextSelectFilter = (r) => r.id === row.id;
    // For update: filter matches same row.
    fake.nextSelectFilter = (r) => r.id === row.id;
    // Trick: we need TWO consecutive filters. Use a helper — re-plant after getApproval.
    // We'll just rely on fake to apply the planted filter when needed.
    // Override fake to always match by id for this test:
    fake.nextSelectFilter = (r) => r.id === row.id;

    // Wire both ops: the test's fake reuses nextSelectFilter once per op.
    // Since decide does getApproval() + update(), plant once; after
    // getApproval consumes it, the UPDATE uses a new filter. Plant a
    // fresh one by passing through directly-matching filter for update.
    // Simplest: attach generic filter to each call via two-step patch.

    // Reset and plant for getApproval:
    fake.nextSelectFilter = (r) => r.id === row.id;
    // Call decideApproval — it will getApproval (uses & consumes the filter),
    // then UPDATE (nextSelectFilter is null → update's builder uses default
    // which is () => false, matching nothing). Bug: we need to re-plant.
    // Workaround: override fake's update to always match by id for this test.
    const origUpdate = fake.update.bind(fake);
    fake.update = () => ({
      set: (patch: Partial<ToolApproval>) => ({
        where: () => ({
          returning: async () => {
            const hits: ToolApproval[] = [];
            for (const r of fake.rows) {
              if (r.id === row.id && r.status === "pending") {
                Object.assign(r, patch);
                hits.push(r);
              }
            }
            return hits;
          },
        }),
      }),
    });

    const desc = await decideApproval({
      approvalId: row.id,
      action: "send",
      deciderUserId: 10,
    });
    expect(desc.approval.status).toBe("approved");
    expect(desc.approval.finalPayload).toEqual(row.draftPayload);
    expect(desc.shouldExecute).toBe(true);
    expect(desc.payloadToExecute).toEqual(row.draftPayload);

    fake.update = origUpdate;
  });

  it("edit → edited, final_payload=editedPayload, shouldExecute=true", async () => {
    const row = await seedPending();
    fake.nextSelectFilter = (r) => r.id === row.id;
    fake.update = () => ({
      set: (patch: Partial<ToolApproval>) => ({
        where: () => ({
          returning: async () => {
            for (const r of fake.rows) {
              if (r.id === row.id && r.status === "pending") {
                Object.assign(r, patch);
                return [r];
              }
            }
            return [];
          },
        }),
      }),
    });

    const edited = { to: "alice@example.com", subject: "hi, edited" };
    const desc = await decideApproval({
      approvalId: row.id,
      action: "edit",
      deciderUserId: 10,
      editedPayload: edited,
    });
    expect(desc.approval.status).toBe("edited");
    expect(desc.approval.finalPayload).toEqual(edited);
    expect(desc.shouldExecute).toBe(true);
    expect(desc.payloadToExecute).toEqual(edited);
  });

  it("reject → rejected, final_payload=null, shouldExecute=false", async () => {
    const row = await seedPending();
    fake.nextSelectFilter = (r) => r.id === row.id;
    fake.update = () => ({
      set: (patch: Partial<ToolApproval>) => ({
        where: () => ({
          returning: async () => {
            for (const r of fake.rows) {
              if (r.id === row.id && r.status === "pending") {
                Object.assign(r, patch);
                return [r];
              }
            }
            return [];
          },
        }),
      }),
    });

    const desc = await decideApproval({
      approvalId: row.id,
      action: "reject",
      deciderUserId: 10,
      note: "wrong recipient",
    });
    expect(desc.approval.status).toBe("rejected");
    expect(desc.approval.finalPayload).toBeNull();
    expect(desc.approval.decisionNote).toBe("wrong recipient");
    expect(desc.shouldExecute).toBe(false);
    expect(desc.payloadToExecute).toBeNull();
  });

  it("edit without editedPayload → throws approval_edit_missing_payload", async () => {
    await expect(
      decideApproval({
        approvalId: "any",
        action: "edit",
        deciderUserId: 10,
      }),
    ).rejects.toMatchObject({ code: "approval_edit_missing_payload" });
  });

  it("invalid action → throws approval_invalid_action", async () => {
    await expect(
      decideApproval({
        approvalId: "any",
        // @ts-expect-error intentional bad input
        action: "bogus",
        deciderUserId: 10,
      }),
    ).rejects.toMatchObject({ code: "approval_invalid_action" });
  });

  it("unknown approval id → throws approval_not_found", async () => {
    fake.nextSelectFilter = () => false; // empty result
    await expect(
      decideApproval({
        approvalId: "nonexistent",
        action: "send",
        deciderUserId: 10,
      }),
    ).rejects.toMatchObject({ code: "approval_not_found" });
  });

  it("wrong user → throws approval_not_authorized", async () => {
    const row = await seedPending();
    fake.nextSelectFilter = (r) => r.id === row.id;
    await expect(
      decideApproval({
        approvalId: row.id,
        action: "send",
        deciderUserId: 999,
      }),
    ).rejects.toMatchObject({ code: "approval_not_authorized" });
  });

  it("already-decided → throws approval_already_decided", async () => {
    const row = await seedPending();
    row.status = "approved"; // simulate decided
    fake.nextSelectFilter = (r) => r.id === row.id;
    await expect(
      decideApproval({
        approvalId: row.id,
        action: "send",
        deciderUserId: 10,
      }),
    ).rejects.toMatchObject({ code: "approval_already_decided" });
  });

  it("ApprovalError carries a code", () => {
    const err = new ApprovalError("approval_not_found", "boom");
    expect(err.code).toBe("approval_not_found");
    expect(err.name).toBe("ApprovalError");
    expect(err.message).toBe("boom");
  });
});

// ─── getApproval / listPendingForUser / countPendingForUser ─────

describe("gate: reads", () => {
  it("getApproval returns the row when found", async () => {
    const row = await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_new_email",
      draftPayload: { to: "x@y.z" },
    });
    fake.nextSelectFilter = (r) => r.id === row.id;
    const fetched = await getApproval(row.id);
    expect(fetched?.id).toBe(row.id);
  });

  it("getApproval returns null when not found", async () => {
    fake.nextSelectFilter = () => false;
    expect(await getApproval("nope")).toBeNull();
  });

  it("listPendingForUser returns pending rows for that user", async () => {
    await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_new_email",
      draftPayload: { to: "x@y.z" },
    });
    await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_email_reply",
      draftPayload: { to: "a@b.c" },
    });
    await createPendingApproval({
      agentId: 16,
      userId: 99, // different user
      toolName: "send_new_email",
      draftPayload: { to: "z@z.z" },
    });

    fake.nextSelectFilter = (r) => r.userId === 10 && r.status === "pending";
    const list = await listPendingForUser(10, 50);
    expect(list.length).toBe(2);
    expect(list.every((r) => r.userId === 10)).toBe(true);
  });

  it("countPendingForUser returns count", async () => {
    await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_new_email",
      draftPayload: { to: "x@y.z" },
    });
    await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_email_reply",
      draftPayload: { to: "a@b.c" },
    });
    fake.nextSelectFilter = (r) => r.userId === 10 && r.status === "pending";
    const n = await countPendingForUser(10);
    expect(n).toBe(2);
  });
});

// ─── recordExecutionResult ────────────────────────────────────────

describe("gate: recordExecutionResult", () => {
  it("stamps executed_at + execution_result on success", async () => {
    const row = await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_new_email",
      draftPayload: { to: "x@y.z" },
    });
    fake.nextSelectFilter = (r) => r.id === row.id;
    fake.update = () => ({
      set: (patch: Partial<ToolApproval>) => ({
        where: () => ({
          returning: async () => {
            for (const r of fake.rows) {
              if (r.id === row.id) {
                Object.assign(r, patch);
                return [r];
              }
            }
            return [];
          },
        }),
      }),
    });
    const updated = await recordExecutionResult(row.id, {
      ok: true,
      result: { sent: true, messageId: "abc" },
    });
    expect(updated?.executedAt).toBeInstanceOf(Date);
    expect(updated?.executionResult).toEqual({ sent: true, messageId: "abc" });
  });

  it("flips status=error on ok=false", async () => {
    const row = await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_new_email",
      draftPayload: { to: "x@y.z" },
    });
    row.status = "approved";
    fake.update = () => ({
      set: (patch: Partial<ToolApproval>) => ({
        where: () => ({
          returning: async () => {
            for (const r of fake.rows) {
              if (r.id === row.id) {
                Object.assign(r, patch);
                return [r];
              }
            }
            return [];
          },
        }),
      }),
    });
    const updated = await recordExecutionResult(row.id, {
      ok: false,
      result: { error: "smtp_timeout" },
    });
    expect(updated?.status).toBe("error");
  });
});

// ─── expirePending ────────────────────────────────────────────────

describe("gate: expirePending", () => {
  it("flips past-deadline pending rows to timeout, returns them", async () => {
    const now = new Date("2026-04-22T12:00:00Z");
    const past = new Date("2026-04-22T11:59:00Z"); // 1 min in the past
    const future = new Date("2026-04-22T13:00:00Z"); // 1h in the future

    const expired = await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_new_email",
      draftPayload: { to: "x@y.z" },
      ttlMs: 1000,
    });
    expired.expiresAt = past;

    const still = await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_email_reply",
      draftPayload: { to: "a@b.c" },
      ttlMs: 1000,
    });
    still.expiresAt = future;

    const decided = await createPendingApproval({
      agentId: 16,
      userId: 10,
      toolName: "send_new_email",
      draftPayload: { to: "q@q.q" },
      ttlMs: 1000,
    });
    decided.expiresAt = past;
    decided.status = "approved"; // should NOT be touched

    fake.update = () => ({
      set: (patch: Partial<ToolApproval>) => ({
        where: () => ({
          returning: async () => {
            const hits: ToolApproval[] = [];
            for (const r of fake.rows) {
              if (r.status === "pending" && r.expiresAt < now) {
                Object.assign(r, patch);
                hits.push(r);
              }
            }
            return hits;
          },
        }),
      }),
    });

    const flipped = await expirePending(now);
    expect(flipped.length).toBe(1);
    expect(flipped[0].id).toBe(expired.id);
    expect(flipped[0].status).toBe("timeout");
    expect(still.status).toBe("pending");
    expect(decided.status).toBe("approved");
  });
});
