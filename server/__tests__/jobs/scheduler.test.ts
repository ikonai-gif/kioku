/**
 * Tests for lib/jobs/scheduler.ts — isDue() gate logic + tick dispatching.
 *
 * The scheduler module exports JOBS as a mutable const array. We mutate it
 * in-test by replacing entries via __test__.JOBS.splice() to isolate test
 * jobs from the real registration (daily-backup + missed-by-both).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Shared mutable state via globalThis so hoisted vi.mock() factories can
// reach the same mock function we drive from tests.
(globalThis as any).__jobsSchedTest = {
  runWithClaim: vi.fn(),
  notifyJob: vi.fn(async () => ({ delivered: true, status: 204 })),
};

vi.mock("../../lib/jobs/jobs-webhook", () => ({
  notifyJob: (...args: any[]) => (globalThis as any).__jobsSchedTest.notifyJob(...args),
}));

vi.mock("../../lib/jobs/job-runs", async () => {
  const actual = await vi.importActual<any>("../../lib/jobs/job-runs");
  return {
    ...actual,
    runWithClaim: (...args: any[]) => (globalThis as any).__jobsSchedTest.runWithClaim(...args),
  };
});

const runWithClaimMock = (globalThis as any).__jobsSchedTest.runWithClaim as ReturnType<typeof vi.fn>;
const notifyJobMock = (globalThis as any).__jobsSchedTest.notifyJob as ReturnType<typeof vi.fn>;

import { __test__ as sched } from "../../lib/jobs/scheduler";
import type { InternalJob } from "../../lib/jobs/scheduler";

describe("jobs/scheduler · isDue", () => {
  it("matches exact UTC hour and minute", () => {
    const j: InternalJob = {
      id: "x",
      utcHour: 13,
      utcMinute: 0,
      schedule: "daily",
      run: async () => {},
    };
    expect(sched.isDue(j, new Date(Date.UTC(2026, 3, 24, 13, 0)))).toBe(true);
    expect(sched.isDue(j, new Date(Date.UTC(2026, 3, 24, 12, 59)))).toBe(false);
    expect(sched.isDue(j, new Date(Date.UTC(2026, 3, 24, 14, 0)))).toBe(false);
  });

  it("matches minute+1 for tick jitter", () => {
    const j: InternalJob = {
      id: "x",
      utcHour: 13,
      utcMinute: 0,
      schedule: "daily",
      run: async () => {},
    };
    expect(sched.isDue(j, new Date(Date.UTC(2026, 3, 24, 13, 1)))).toBe(true);
    expect(sched.isDue(j, new Date(Date.UTC(2026, 3, 24, 13, 2)))).toBe(false);
  });

  it("annual schedule gates by month+day", () => {
    const j: InternalJob = {
      id: "ann",
      utcHour: 16,
      utcMinute: 0,
      schedule: { month: 7, day: 21 },
      run: async () => {},
    };
    expect(sched.isDue(j, new Date(Date.UTC(2026, 6, 21, 16, 0)))).toBe(true);  // month index 6 = July
    expect(sched.isDue(j, new Date(Date.UTC(2026, 6, 22, 16, 0)))).toBe(false);
    expect(sched.isDue(j, new Date(Date.UTC(2026, 5, 21, 16, 0)))).toBe(false);
  });

  it("disabled jobs never fire", () => {
    const j: InternalJob = {
      id: "x",
      utcHour: 13,
      utcMinute: 0,
      schedule: "daily",
      disabled: true,
      run: async () => {},
    };
    expect(sched.isDue(j, new Date(Date.UTC(2026, 3, 24, 13, 0)))).toBe(false);
  });
});

describe("jobs/scheduler · tick", () => {
  let savedJobs: InternalJob[];

  beforeEach(() => {
    savedJobs = sched.JOBS.splice(0, sched.JOBS.length);
    runWithClaimMock.mockReset();
  });
  afterEach(() => {
    sched.JOBS.splice(0, sched.JOBS.length, ...savedJobs);
  });

  it("does nothing when no job is due", async () => {
    sched.JOBS.push({
      id: "noop",
      utcHour: 9,
      utcMinute: 0,
      schedule: "daily",
      run: async () => ({}),
    });
    await sched.tick(new Date(Date.UTC(2026, 3, 24, 13, 0)));
    expect(runWithClaimMock).not.toHaveBeenCalled();
  });

  it("invokes runWithClaim for each due job", async () => {
    const ran: string[] = [];
    runWithClaimMock.mockImplementation(async (id: string, fn: any) => {
      await fn();
      ran.push(id);
      return { ran: true, status: "ok", runId: 1, durationMs: 10 };
    });
    sched.JOBS.push({
      id: "due-job",
      utcHour: 13,
      utcMinute: 0,
      schedule: "daily",
      run: async () => ({ ok: true }),
    });
    await sched.tick(new Date(Date.UTC(2026, 3, 24, 13, 0)));
    expect(ran).toEqual(["due-job"]);
  });

  it("alerts on status=error", async () => {
    notifyJobMock.mockClear();
    runWithClaimMock.mockResolvedValue({
      ran: true,
      status: "error",
      runId: 1,
      durationMs: 10,
      error: "boom",
    });
    sched.JOBS.push({
      id: "err-job",
      utcHour: 13,
      utcMinute: 0,
      schedule: "daily",
      run: async () => {},
    });
    await sched.tick(new Date(Date.UTC(2026, 3, 24, 13, 0)));
    expect(notifyJobMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const payload = notifyJobMock.mock.calls.at(-1)![0];
    expect(payload.severity).toBe("critical");
    expect(payload.title).toMatch(/err-job/);
  });

  it("does not alert on skipped runs", async () => {
    notifyJobMock.mockClear();
    runWithClaimMock.mockResolvedValue({
      ran: false,
      status: "skipped",
      reason: "already_claimed",
    });
    sched.JOBS.push({
      id: "skip-job",
      utcHour: 13,
      utcMinute: 0,
      schedule: "daily",
      run: async () => {},
    });
    await sched.tick(new Date(Date.UTC(2026, 3, 24, 13, 0)));
    expect(notifyJobMock.mock.calls.length).toBe(0);
  });
});

describe("jobs/scheduler · registered jobs", () => {
  it("registers daily-user-backup at 13:00 UTC", () => {
    const found = savedJobsSnapshot().find((j) => j.id === "daily-user-backup");
    expect(found).toBeDefined();
    expect(found!.utcHour).toBe(13);
    expect(found!.utcMinute).toBe(0);
    expect(found!.schedule).toBe("daily");
  });

  it("registers missed-by-both annual review at 7/21 16:00 UTC", () => {
    const found = savedJobsSnapshot().find((j) => j.id === "missed-by-both-annual-review");
    expect(found).toBeDefined();
    expect(found!.utcHour).toBe(16);
    expect(found!.schedule).toEqual({ month: 7, day: 21 });
  });
});

// Helper: snapshot the registered JOBS before any mutation in tests.
// Because vitest describes run sequentially within a file, this is safe
// because the `beforeEach` that empties JOBS has already run. We stash
// into module-private state via closure.
const __original = [] as InternalJob[];
for (const j of sched.JOBS) __original.push(j);
function savedJobsSnapshot(): InternalJob[] {
  return __original;
}
