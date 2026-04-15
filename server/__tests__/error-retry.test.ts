import { describe, it, expect, vi } from "vitest";
import {
  classifyLLMError,
  classifyWebhookError,
  withRetry,
  checkCircuitBreaker,
  formatErrorLog,
  type AgentErrorLog,
} from "../error-retry";

describe("classifyLLMError", () => {
  it("classifies timeout/abort errors", () => {
    const abortErr = { name: "AbortError", message: "The operation was aborted" };
    expect(classifyLLMError(abortErr).category).toBe("TIMEOUT");

    const timeoutErr = { message: "Request timeout after 45s" };
    expect(classifyLLMError(timeoutErr).category).toBe("TIMEOUT");

    const etimedoutErr = { message: "connect ETIMEDOUT 1.2.3.4:443" };
    expect(classifyLLMError(etimedoutErr).category).toBe("TIMEOUT");
  });

  it("classifies rate limit errors (429)", () => {
    const err = { status: 429, message: "Rate limit exceeded" };
    const classified = classifyLLMError(err);
    expect(classified.category).toBe("RATE_LIMITED");
    expect(classified.statusCode).toBe(429);
  });

  it("parses Retry-After header for rate limits", () => {
    const err = { status: 429, message: "Rate limit", headers: { "retry-after": "30" } };
    const classified = classifyLLMError(err);
    expect(classified.retryAfterMs).toBe(30000);
  });

  it("classifies auth errors as permanent (401, 403)", () => {
    expect(classifyLLMError({ status: 401, message: "Unauthorized" }).category).toBe("PERMANENT");
    expect(classifyLLMError({ status: 403, message: "Forbidden" }).category).toBe("PERMANENT");
  });

  it("classifies bad request as permanent (400)", () => {
    expect(classifyLLMError({ status: 400, message: "Bad request" }).category).toBe("PERMANENT");
  });

  it("classifies 'not configured' as permanent", () => {
    expect(classifyLLMError({ message: "OPENAI_API_KEY not configured" }).category).toBe("PERMANENT");
  });

  it("classifies server errors as retryable (5xx)", () => {
    expect(classifyLLMError({ status: 500, message: "Internal server error" }).category).toBe("RETRYABLE");
    expect(classifyLLMError({ status: 503, message: "Service unavailable" }).category).toBe("RETRYABLE");
  });

  it("classifies network errors as retryable", () => {
    expect(classifyLLMError({ message: "connect ECONNREFUSED" }).category).toBe("RETRYABLE");
    expect(classifyLLMError({ message: "getaddrinfo ENOTFOUND api.openai.com" }).category).toBe("RETRYABLE");
    expect(classifyLLMError({ message: "socket hang up ECONNRESET" }).category).toBe("RETRYABLE");
  });

  it("defaults unknown errors to retryable", () => {
    expect(classifyLLMError({ message: "something weird happened" }).category).toBe("RETRYABLE");
  });
});

describe("classifyWebhookError", () => {
  it("classifies timeout errors", () => {
    expect(classifyWebhookError({ name: "AbortError" }).category).toBe("TIMEOUT");
    expect(classifyWebhookError({ message: "Webhook timeout (15s)" }).category).toBe("TIMEOUT");
  });

  it("classifies 4xx as permanent", () => {
    expect(classifyWebhookError({ message: "Webhook 404: Not Found" }).category).toBe("PERMANENT");
    expect(classifyWebhookError({ message: "Webhook 401: Unauthorized" }).category).toBe("PERMANENT");
  });

  it("classifies 5xx as retryable", () => {
    expect(classifyWebhookError({ message: "Webhook 503: Service unavailable" }).category).toBe("RETRYABLE");
    expect(classifyWebhookError({ message: "Webhook 500: Internal Server Error" }).category).toBe("RETRYABLE");
  });

  it("classifies network errors as retryable", () => {
    expect(classifyWebhookError({ message: "fetch failed" }).category).toBe("RETRYABLE");
    expect(classifyWebhookError({ message: "connect ECONNREFUSED" }).category).toBe("RETRYABLE");
  });
});

describe("withRetry", () => {
  it("returns success on first attempt if fn succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, {
      maxRetries: 2,
      backoffMs: [10, 20],
      classifier: classifyLLMError,
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 500, message: "Server error" })
      .mockResolvedValue("recovered");
    const result = await withRetry(fn, {
      maxRetries: 2,
      backoffMs: [10, 20],
      classifier: classifyLLMError,
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("recovered");
    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on permanent error", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 401, message: "Unauthorized" });
    const result = await withRetry(fn, {
      maxRetries: 2,
      backoffMs: [10, 20],
      classifier: classifyLLMError,
    });
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe("PERMANENT");
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts all retries on repeated retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 500, message: "Server error" });
    const result = await withRetry(fn, {
      maxRetries: 2,
      backoffMs: [10, 20],
      classifier: classifyLLMError,
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3); // 1 initial + 2 retries
    expect(fn).toHaveBeenCalledTimes(3);
    expect(result.errors).toHaveLength(3);
  });

  it("timeout errors get at most 1 retry", async () => {
    const fn = vi.fn().mockRejectedValue({ name: "AbortError", message: "timeout" });
    const result = await withRetry(fn, {
      maxRetries: 3,
      backoffMs: [10, 20, 30],
      classifier: classifyLLMError,
    });
    // Timeout gets 1 retry (attempt 0 + attempt 1), then fails
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("records errors with willRetry flag", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 500, message: "err1" })
      .mockRejectedValue({ status: 401, message: "permanent" });
    const result = await withRetry(fn, {
      maxRetries: 2,
      backoffMs: [10, 20],
      classifier: classifyLLMError,
    });
    expect(result.errors[0].willRetry).toBe(true);
    expect(result.errors[1].willRetry).toBe(false);
  });
});

describe("checkCircuitBreaker", () => {
  it("resets on success", () => {
    const result = checkCircuitBreaker(2, true);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.tripped).toBe(false);
  });

  it("increments failure count on failure", () => {
    const result = checkCircuitBreaker(1, false, "some error");
    expect(result.consecutiveFailures).toBe(2);
    expect(result.tripped).toBe(false);
  });

  it("trips at threshold (3 consecutive failures)", () => {
    const result = checkCircuitBreaker(2, false, "third failure");
    expect(result.consecutiveFailures).toBe(3);
    expect(result.tripped).toBe(true);
    expect(result.errorMessage).toBe("third failure");
  });

  it("trips beyond threshold", () => {
    const result = checkCircuitBreaker(5, false, "sixth failure");
    expect(result.consecutiveFailures).toBe(6);
    expect(result.tripped).toBe(true);
  });

  it("truncates error message to 200 chars", () => {
    const longMsg = "x".repeat(300);
    const result = checkCircuitBreaker(2, false, longMsg);
    expect(result.errorMessage!.length).toBe(200);
  });
});

describe("formatErrorLog", () => {
  it("formats error log entry correctly", () => {
    const entry: AgentErrorLog = {
      agentId: 42,
      agentName: "TestAgent",
      errorType: "RETRYABLE",
      errorMessage: "Server error 500",
      attemptNumber: 2,
      willRetry: true,
      sessionId: "dlb_1_12345",
    };
    const log = formatErrorLog(entry);
    expect(log).toContain("agent=42");
    expect(log).toContain("(TestAgent)");
    expect(log).toContain("type=RETRYABLE");
    expect(log).toContain("attempt=2");
    expect(log).toContain("retry=true");
    expect(log).toContain("Server error 500");
  });
});
