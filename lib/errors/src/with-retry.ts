/**
 * `withRetry` — exponential backoff with optional jitter.
 *
 * Retries `fn` up to `maxAttempts` times. `attempt` is zero-indexed: the
 * first call is attempt 0; if it throws and `shouldRetry` returns true, the
 * helper sleeps `baseDelayMs * 2^0 * (1 ± jitter)` before attempt 1, then
 * `baseDelayMs * 2^1 * (1 ± jitter)` before attempt 2, and so on, capped at
 * `maxDelayMs`. With `baseDelayMs=200` (default), the first retry delay is
 * therefore 200ms ± jitter — NOT 400ms.
 *
 * The `attempt` value passed to `onRetry` is the index of the attempt that
 * just failed (0 for the first call), so `onRetry` always sees attempts in
 * the range [0, maxAttempts - 2].
 *
 * `shouldRetry(err, attempt)` decides whether a given failure is retryable.
 * The default policy retries network/timeout/integration errors and
 * non-DomainError throwables; it does NOT retry validation, auth, permission,
 * tenant-isolation, or tool errors (those are deterministic failures).
 *
 * On exhaustion, the helper re-throws the last error unchanged so the caller
 * can introspect / map it.
 */
import { DomainError } from "./error-taxonomy.js";

export interface WithRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** 0 = no jitter, 1 = ±100% jitter. Default 0.2 (±20%). */
  readonly jitter?: number;
  readonly shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Hook for tests / observability. Called before each delay. */
  readonly onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Sleep implementation override for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  jitter: 0.2,
} as const;

// tier-review: bounded — finite enum of DomainError.domain values, never grows at runtime
const NON_RETRYABLE_DOMAINS = new Set([
  "validation",
  "auth",
  "permission",
  "tenant",
  "tool",
]);

export function defaultShouldRetry(err: unknown, _attempt: number): boolean {
  if (err instanceof DomainError) {
    return !NON_RETRYABLE_DOMAINS.has(err.domain);
  }
  return true;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const jitter = options.jitter ?? DEFAULTS.jitter;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  const sleep = options.sleep ?? defaultSleep;

  if (maxAttempts < 1) {
    throw new RangeError("withRetry: maxAttempts must be >= 1");
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !shouldRetry(err, attempt)) {
        throw err;
      }
      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const jitterFactor = 1 + (Math.random() * 2 - 1) * jitter;
      const delay = Math.max(0, Math.round(exp * jitterFactor));
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
