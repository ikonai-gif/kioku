/**
 * Test-oriented Express app factory.
 *
 * Production boot remains in `server/index.ts` (Sentry, rate limiting,
 * Vite, request logging, graceful shutdown, etc. — all intentionally
 * out of scope here). This factory exists so integration tests can spin
 * up a lean app against a real Postgres without pulling in the full
 * production startup path (which has module-load side effects like
 * Sentry init, WS server creation, and scheduler start).
 *
 * **Zero side effects at module load.** All state is created inside
 * `createApp()`.
 *
 * Scope of the factory:
 *   - express.json + cookie-parser + urlencoded (matches production)
 *   - Meeting Room routes (the surface exercised by integration tests)
 *   - A test-injectable `getUser` so tests don't need the full auth stack
 *
 * If future integration tests need additional routes, wire them here
 * behind the same `CreateAppOptions.getUser` hook.
 */

import express, { type Express, type Request } from "express";
import cookieParser from "cookie-parser";
import { registerMeetingRoutes } from "./routes/meetings";

export interface CreateAppOptions {
  /**
   * Resolve the caller's user id from the request. Tests typically pass a
   * stub (e.g. `async () => 1`) to bypass the cookie/JWT stack.
   * If omitted, defaults to a stub that returns `null` (unauthenticated)
   * — integration tests should always inject a real resolver.
   */
  getUser?: (req: Request) => Promise<number | null>;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<Express> {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false, limit: "128kb" }));
  app.use(cookieParser());

  const getUser = opts.getUser ?? (async () => null);
  registerMeetingRoutes(app, getUser);

  return app;
}
