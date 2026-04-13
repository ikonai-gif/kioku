/**
 * Error Classification + Retry Logic — KIOKU™
 * Exponential backoff, error categories, and circuit breaker for agent adapters.
 */

// ── Error Categories ─────────────────────────────────────────────

export type ErrorCategory = "RETRYABLE" | "PERMANENT" | "TIMEOUT" | "RATE_LIMITED";

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  statusCode?: number;
  retryAfterMs?: number; // for RATE_LIMITED — from Retry-After header
}

/**
 * Classify an error thrown by an internal LLM call (OpenAI / Gemini).
 */
export function classifyLLMError(err: any): ClassifiedError {
  const message = err?.message || String(err);
  const status = err?.status ?? err?.statusCode ?? extractStatusFromMessage(message);

  // Timeout / abort
  if (err?.name === "AbortError" || message.includes("timeout") || message.includes("ETIMEDOUT")) {
    return { category: "TIMEOUT", message, statusCode: status };
  }

  // Rate limiting
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(err);
    return { category: "RATE_LIMITED", message, statusCode: 429, retryAfterMs };
  }

  // Permanent errors — do NOT retry
  if (status === 401 || status === 403) {
    return { category: "PERMANENT", message: `Auth error (${status}): ${message}`, statusCode: status };
  }
  if (status === 400) {
    return { category: "PERMANENT", message: `Bad request: ${message}`, statusCode: 400 };
  }
  if (message.includes("not configured") || message.includes("Invalid model") || message.includes("not found")) {
    return { category: "PERMANENT", message };
  }

  // Server errors — retryable
  if (status && status >= 500) {
    return { category: "RETRYABLE", message, statusCode: status };
  }

  // Network errors — retryable
  if (message.includes("ECONNREFUSED") || message.includes("ENOTFOUND") || message.includes("ECONNRESET") ||
      message.includes("fetch failed") || message.includes("network") || err?.code === "ECONNREFUSED") {
    return { category: "RETRYABLE", message };
  }

  // Default: treat unknown errors as retryable (conservative)
  return { category: "RETRYABLE", message };
}

/**
 * Classify an error thrown by a webhook call.
 */
export function classifyWebhookError(err: any): ClassifiedError {
  const message = err?.message || String(err);
  const status = extractStatusFromMessage(message);

  // Timeout
  if (err?.name === "AbortError" || message.includes("timeout") || message.includes("ETIMEDOUT")) {
    return { category: "TIMEOUT", message };
  }

  // 4xx — permanent (client errors, bad config)
  if (status && status >= 400 && status < 500) {
    return { category: "PERMANENT", message, statusCode: status };
  }

  // 5xx — retryable
  if (status && status >= 500) {
    return { category: "RETRYABLE", message, statusCode: status };
  }

  // Network errors
  if (message.includes("ECONNREFUSED") || message.includes("ENOTFOUND") || message.includes("ECONNRESET") ||
      message.includes("fetch failed")) {
    return { category: "RETRYABLE", message };
  }

  // Default for webhooks: retryable
  return { category: "RETRYABLE", message };
}

// ── Retry Engine ─────────────────────────────────────────────────

export interface RetryOptions {
  maxRetries: number;
  backoffMs: number[];       // delay per attempt index, e.g. [1000, 3000]
  classifier: (err: any) => ClassifiedError;
}

export interface RetryResult<T> {
  success: boolean;
  value?: T;
  error?: ClassifiedError;
  attempts: number;
  errors: Array<{ attempt: number; error: ClassifiedError; willRetry: boolean }>;
}

/**
 * Execute a function with retry logic and exponential backoff.
 * Only retries on RETRYABLE / TIMEOUT / RATE_LIMITED errors.
 * PERMANENT errors fail immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<RetryResult<T>> {
  const { maxRetries, backoffMs, classifier } = options;
  const errors: RetryResult<T>["errors"] = [];
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    try {
      const value = await fn();
      return { success: true, value, attempts, errors };
    } catch (err) {
      const classified = classifier(err);
      const canRetry = attempt < maxRetries && classified.category !== "PERMANENT";
      // TIMEOUT gets one retry, then fail
      const timeoutExhausted = classified.category === "TIMEOUT" && attempt >= 1;
      const willRetry = canRetry && !timeoutExhausted;

      errors.push({ attempt, error: classified, willRetry });

      if (!willRetry) {
        return { success: false, error: classified, attempts, errors };
      }

      // Determine delay
      let delayMs = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 1000;
      if (classified.category === "RATE_LIMITED" && classified.retryAfterMs) {
        delayMs = Math.max(delayMs, classified.retryAfterMs);
      }

      console.warn(
        `[error-retry] Attempt ${attempt + 1}/${maxRetries + 1} failed (${classified.category}): ${classified.message.slice(0, 100)}. Retrying in ${delayMs}ms…`
      );

      await sleep(delayMs);
    }
  }

  // Should not reach here, but safety net
  return { success: false, error: { category: "RETRYABLE", message: "Max retries exhausted" }, attempts, errors };
}

// ── Circuit Breaker (Lightweight) ────────────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 3; // consecutive failures to trip

export interface CircuitBreakerUpdate {
  agentId: number;
  tripped: boolean;
  consecutiveFailures: number;
  errorMessage?: string;
}

/**
 * Check if the circuit breaker should trip for an agent.
 * Returns update to apply to agent record.
 */
export function checkCircuitBreaker(
  currentFailures: number,
  success: boolean,
  errorMessage?: string
): { consecutiveFailures: number; tripped: boolean; errorMessage?: string } {
  if (success) {
    return { consecutiveFailures: 0, tripped: false };
  }
  const newFailures = currentFailures + 1;
  return {
    consecutiveFailures: newFailures,
    tripped: newFailures >= CIRCUIT_BREAKER_THRESHOLD,
    errorMessage: errorMessage?.slice(0, 200),
  };
}

// ── Error Log Entry ──────────────────────────────────────────────

export interface AgentErrorLog {
  agentId: number;
  agentName: string;
  errorType: ErrorCategory;
  errorMessage: string;
  attemptNumber: number;
  willRetry: boolean;
  sessionId?: string;
}

export function formatErrorLog(entry: AgentErrorLog): string {
  return `[error-retry] agent=${entry.agentId} (${entry.agentName}) type=${entry.errorType} attempt=${entry.attemptNumber} retry=${entry.willRetry} msg=${entry.errorMessage.slice(0, 150)}`;
}

// ── Helpers ──────────────────────────────────────────────────────

function extractStatusFromMessage(msg: string): number | undefined {
  // Match patterns like "Webhook 503:" or "error 429:" or "HTTP 500"
  const match = msg.match(/\b(\d{3})\b/);
  const code = match ? parseInt(match[1], 10) : undefined;
  return code && code >= 100 && code < 600 ? code : undefined;
}

function parseRetryAfter(err: any): number | undefined {
  // OpenAI SDK puts headers on the error
  const retryAfter = err?.headers?.["retry-after"] ?? err?.response?.headers?.["retry-after"];
  if (!retryAfter) return undefined;
  const seconds = parseFloat(retryAfter);
  if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
  // Could be a date string
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
