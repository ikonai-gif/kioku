/**
 * R469 — /api/billing/status must accept the httpOnly `kioku_session` cookie.
 *
 * Before R469 `resolveUser` only checked `x-session-token` header, so browser
 * sessions after the cookie-only auto-restore flow got 401. That 401 tripped
 * the SPA's global 401 handler and force-logged Boss out on Boss Board load.
 */
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

// Mock storage so the billing route doesn't require a real DB.
vi.mock("../storage.js", () => ({
  storage: {
    getUser: async (id: number) =>
      id === 10
        ? { id: 10, plan: "enterprise", billingCycle: "monthly", stripeCustomerId: "cus_test" }
        : null,
    getUserByApiKey: async () => null,
  },
}));

import { vi } from "vitest";
import { registerBilling } from "../billing";

const JWT_SECRET = "dev-only-secret";

function makeApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  registerBilling(app);
  return app;
}

describe("R469: /api/billing/status cookie auth", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  it("401 when no credentials", async () => {
    const res = await request(makeApp()).get("/api/billing/status");
    expect(res.status).toBe(401);
  });

  it("200 with x-session-token header (legacy)", async () => {
    const token = jwt.sign({ userId: 10 }, JWT_SECRET, { algorithm: "HS256" });
    const res = await request(makeApp())
      .get("/api/billing/status")
      .set("x-session-token", token);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("enterprise");
  });

  it("R469: 200 with kioku_session cookie only (browser flow)", async () => {
    const token = jwt.sign({ userId: 10 }, JWT_SECRET, { algorithm: "HS256" });
    const res = await request(makeApp())
      .get("/api/billing/status")
      .set("Cookie", [`kioku_session=${token}`]);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("enterprise");
  });

  it("401 when cookie token is invalid", async () => {
    const res = await request(makeApp())
      .get("/api/billing/status")
      .set("Cookie", ["kioku_session=garbage.jwt.token"]);
    expect(res.status).toBe(401);
  });
});
