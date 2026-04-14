/**
 * KIOKU™ Structured Logging — Pino
 * JSON in production, pretty in dev
 */

import pino from "pino";
import crypto from "crypto";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino/file",
          options: { destination: 1 }, // stdout
        },
      }),
});

export default logger;

/**
 * Generate a unique request ID for tracing
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Create a child logger with request context
 */
export function createRequestLogger(opts: { requestId: string; userId?: number; method?: string; path?: string }) {
  return logger.child({
    requestId: opts.requestId,
    ...(opts.userId && { userId: opts.userId }),
    ...(opts.method && { method: opts.method }),
    ...(opts.path && { path: opts.path }),
  });
}
