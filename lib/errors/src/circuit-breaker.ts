/**
 * In-house Circuit Breaker — Standard 8 of the project context.
 *
 * Three states:
 *   - `closed`     — calls flow through, failures are counted in the rolling
 *                    window. If the failure rate within the window exceeds
 *                    `errorThresholdPercentage` (and we have at least
 *                    `volumeThreshold` samples), the breaker trips OPEN.
 *   - `open`       — calls fail fast with `CircuitOpenError` (or the
 *                    fallback's value, if a fallback was registered). After
 *                    `resetTimeoutMs` we move to `half-open`.
 *   - `half-open`  — exactly one trial call is allowed. Success → `closed`
 *                    (window reset). Failure → back to `open`.
 *
 * The implementation is dependency-free (no `opossum`) so the package stays
 * small and the workspace's `minimumReleaseAge` policy is never an issue.
 *
 * NOTE: This breaker does NOT add a timeout to the wrapped call. Compose with
 * `withTimeout` at the call site so the two concerns stay orthogonal:
 *   const result = await breaker.execute(() => withTimeout(fetch(...), 5_000));
 *
 * Concurrency: this breaker has no internal lock. In single-threaded Node,
 * concurrent `execute()` calls can all observe `state === "closed"` and
 * proceed simultaneously — that is the intended behaviour (the breaker rate-
 * limits failures, not in-flight calls). The rolling-window stats are only
 * updated when each call settles, so the only race is "did the Nth concurrent
 * failure trip the breaker before or after the (N+1)th call started" — an
 * acceptable best-effort under load. If you need strict single-flight
 * semantics, wrap `execute` in your own mutex / queue.
 */
import { CircuitOpenError } from "./error-taxonomy.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  readonly name: string;
  /** Trip OPEN once the failure rate exceeds this percentage (0-100). */
  readonly errorThresholdPercentage?: number;
  /** Minimum number of calls in the rolling window before stats are evaluated. */
  readonly volumeThreshold?: number;
  /** Window over which calls are counted, in ms. */
  readonly rollingWindowMs?: number;
  /** Time the breaker stays OPEN before allowing a half-open trial. */
  readonly resetTimeoutMs?: number;
  /** Time source override for tests. */
  readonly now?: () => number;
}

interface Sample {
  readonly t: number;
  readonly ok: boolean;
}

const DEFAULTS = {
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  rollingWindowMs: 30_000,
  resetTimeoutMs: 30_000,
} as const;

export class CircuitBreaker {
  public readonly name: string;
  private readonly errorThresholdPercentage: number;
  private readonly volumeThreshold: number;
  private readonly rollingWindowMs: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;
  private samples: Sample[] = [];
  private state: CircuitState = "closed";
  private openedAt = 0;
  private fallback?: <T>() => T | Promise<T>;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.errorThresholdPercentage =
      options.errorThresholdPercentage ?? DEFAULTS.errorThresholdPercentage;
    this.volumeThreshold = options.volumeThreshold ?? DEFAULTS.volumeThreshold;
    this.rollingWindowMs = options.rollingWindowMs ?? DEFAULTS.rollingWindowMs;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULTS.resetTimeoutMs;
    this.now = options.now ?? Date.now;
  }

  public getState(): CircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  /**
   * Register a fallback that produces a value when the breaker is open OR
   * the call rejects. The fallback receives no arguments — close over the
   * call-site context instead.
   */
  public withFallback<T>(fallback: () => T | Promise<T>): this {
    this.fallback = fallback as <U>() => U | Promise<U>;
    return this;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();

    if (this.state === "open") {
      if (this.fallback) return (await this.fallback<T>()) as T;
      throw new CircuitOpenError(this.name);
    }

    try {
      const value = await fn();
      this.recordSuccess();
      return value;
    } catch (err) {
      this.recordFailure();
      if (this.fallback) return (await this.fallback<T>()) as T;
      throw err;
    }
  }

  /** Force the breaker open (e.g. after an admin action). Mostly for tests. */
  public trip(): void {
    this.state = "open";
    this.openedAt = this.now();
  }

  /** Force the breaker closed and clear the window. Mostly for tests. */
  public reset(): void {
    this.state = "closed";
    this.openedAt = 0;
    this.samples = [];
  }

  private maybeHalfOpen(): void {
    if (this.state === "open" && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = "half-open";
    }
  }

  private recordSuccess(): void {
    if (this.state === "half-open") {
      this.reset();
      return;
    }
    this.pushSample(true);
  }

  private recordFailure(): void {
    if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = this.now();
      return;
    }
    this.pushSample(false);
    this.evaluate();
  }

  private pushSample(ok: boolean): void {
    const t = this.now();
    this.samples.push({ t, ok });
    const cutoff = t - this.rollingWindowMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.t < cutoff) drop++;
    if (drop > 0) this.samples = this.samples.slice(drop);
  }

  private evaluate(): void {
    if (this.samples.length < this.volumeThreshold) return;
    const failures = this.samples.reduce((n, s) => n + (s.ok ? 0 : 1), 0);
    const rate = (failures / this.samples.length) * 100;
    if (rate >= this.errorThresholdPercentage) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}
