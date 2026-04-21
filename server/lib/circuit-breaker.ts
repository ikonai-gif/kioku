/**
 * KIOKU™ Circuit Breaker Primitive
 *
 * Library-only — not wired into production routes yet. Week 5 consolidates
 * `new OpenAI()` call sites into a wrapped factory that uses this.
 *
 * State machine: CLOSED → OPEN → HALF_OPEN → CLOSED
 *
 * R4 timeout semantics: timeoutMs does NOT cancel the in-flight fn. It races
 * fn() against a timer and increments failure counters if the timer wins.
 * For true cancellation, callers MUST pass an AbortSignal-aware fn and supply
 * abortOnTimeout — the breaker will call abortOnTimeout.abort() on timeout.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type State = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** O3: Required — human name used in errors and logs. */
  name: string;
  /** Consecutive failures before opening circuit. */
  failureThreshold: number;
  /** Time to wait in OPEN before allowing a HALF_OPEN probe. */
  cooldownMs: number;
  /** Default 1. Successes in HALF_OPEN before returning to CLOSED. */
  successThreshold?: number;
  /**
   * If set, race fn() against a timeout. NOTE: timeout triggers CircuitBreaker
   * failure counting but does NOT cancel the in-flight fn. For true cancellation,
   * caller MUST pass an AbortSignal-aware fn and use abortOnTimeout. (R4)
   */
  timeoutMs?: number;
  /** R4: optional AbortController — aborted when timeoutMs fires. */
  abortOnTimeout?: AbortController;
  /** Predicate for what counts as a failure. Default: all throws. */
  isFailure?: (err: unknown) => boolean;
  /** Called on every state transition. For metrics/logs. */
  onStateChange?: (from: State, to: State, reason: string) => void;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  readonly circuitName: string;
  readonly lastError?: Error; // Q5

  constructor(name: string, retryAfterMs: number, lastError?: Error) {
    super(`[circuit:${name}] OPEN — retry in ${retryAfterMs}ms`);
    this.name = "CircuitOpenError";
    this.circuitName = name;
    this.retryAfterMs = retryAfterMs;
    this.lastError = lastError;
  }
}

export class TimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`[circuit:${name}] timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface CircuitBreakerStats {
  state: State;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  totalCalls: number;
  totalFailures: number;
}

// ── CircuitBreaker ────────────────────────────────────────────────────────────

export class CircuitBreaker {
  private readonly opts: Required<
    Omit<CircuitBreakerOptions, "abortOnTimeout" | "onStateChange" | "isFailure">
  > & Pick<CircuitBreakerOptions, "abortOnTimeout" | "onStateChange" | "isFailure">;

  private _state: State = "CLOSED";
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private lastFailureAt: number | null = null;
  private openedAt: number | null = null;
  private totalCalls = 0;
  private totalFailures = 0;
  private probeInFlight = false;
  private lastError?: Error;

  constructor(opts: CircuitBreakerOptions) {
    this.opts = {
      successThreshold: 1,
      timeoutMs: undefined,
      ...opts,
    } as any;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    switch (this._state) {
      case "OPEN": {
        const elapsed = Date.now() - (this.openedAt ?? 0);
        if (elapsed >= this.opts.cooldownMs) {
          // On-demand flip to HALF_OPEN (not scheduled timer)
          this._transition("OPEN", "HALF_OPEN", "cooldown elapsed");
        } else {
          const retryAfterMs = this.opts.cooldownMs - elapsed;
          throw new CircuitOpenError(this.opts.name, retryAfterMs, this.lastError);
        }
        // Fall through into HALF_OPEN handling
      }
      // falls through

      case "HALF_OPEN": {
        // Only one probe at a time
        if (this.probeInFlight) {
          const elapsed = Date.now() - (this.openedAt ?? 0);
          const retryAfterMs = Math.max(0, this.opts.cooldownMs - elapsed);
          throw new CircuitOpenError(this.opts.name, retryAfterMs, this.lastError);
        }
        this.probeInFlight = true;
        try {
          const result = await this._callWithTimeout(fn);
          this.probeInFlight = false;
          this.consecutiveSuccesses++;
          if (
            this.consecutiveSuccesses >=
            (this.opts.successThreshold ?? 1)
          ) {
            this._transition("HALF_OPEN", "CLOSED", "probe succeeded");
            this._resetCounters();
          }
          return result;
        } catch (err) {
          this.probeInFlight = false;
          if (this._countAsFailure(err)) {
            this.lastError = err instanceof Error ? err : new Error(String(err));
            this.lastFailureAt = Date.now();
            this.totalFailures++;
            // Fresh OPEN with new openedAt
            this.openedAt = Date.now();
            this._transition("HALF_OPEN", "OPEN", "probe failed");
          }
          throw err;
        }
      }

      case "CLOSED": {
        try {
          const result = await this._callWithTimeout(fn);
          // Success resets consecutive failure counter in CLOSED (O4)
          this.consecutiveFailures = 0;
          return result;
        } catch (err) {
          if (this._countAsFailure(err)) {
            this.consecutiveFailures++;
            this.totalFailures++;
            this.lastFailureAt = Date.now();
            this.lastError = err instanceof Error ? err : new Error(String(err));

            if (this.consecutiveFailures >= this.opts.failureThreshold) {
              this.openedAt = Date.now();
              this._transition("CLOSED", "OPEN", `${this.consecutiveFailures} consecutive failures`);
            }
          }
          throw err;
        }
      }
    }
  }

  getState(): State {
    return this._state;
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this._state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailureAt: this.lastFailureAt,
      openedAt: this.openedAt,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
    };
  }

  /** Reset to CLOSED state with zeroed counters. For tests + manual recovery. */
  reset(): void {
    this._transition(this._state, "CLOSED", "manual reset");
    this._resetCounters();
    this.probeInFlight = false;
    this.lastError = undefined;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _transition(from: State, to: State, reason: string): void {
    this._state = to;
    this.opts.onStateChange?.(from, to, reason);
  }

  private _resetCounters(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = null;
    this.lastFailureAt = null;
    this.totalCalls = 0;
    this.totalFailures = 0;
  }

  private _countAsFailure(err: unknown): boolean {
    if (this.opts.isFailure) return this.opts.isFailure(err);
    return true; // default: all throws are failures
  }

  /**
   * R4: Race fn() against timeoutMs.
   * If timeout fires: calls abortOnTimeout?.abort(), increments failure stats
   * (done by caller after this throws), throws TimeoutError.
   * The in-flight fn is NOT awaited/cancelled — caller's responsibility.
   */
  private async _callWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.opts.timeoutMs) {
      return fn();
    }

    const timeoutMs = this.opts.timeoutMs;
    const abortOnTimeout = this.opts.abortOnTimeout;
    const circuitName = this.opts.name;

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // R4: signal abort but do NOT await fn's cleanup
        abortOnTimeout?.abort();
        reject(new TimeoutError(circuitName, timeoutMs));
      }, timeoutMs);

      fn().then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }
}
