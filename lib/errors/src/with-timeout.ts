/**
 * `withTimeout` — fail-fast wrapper around any promise.
 *
 * The returned promise resolves with the input value if it settles before
 * `timeoutMs` elapses; otherwise it rejects with a `TimeoutError`. The
 * underlying operation is NOT cancelled (Node has no first-class cancellation),
 * but if the caller passes an `AbortController` via `onTimeout`, this helper
 * will invoke it so cancellable operations (fetch, child_process.kill, etc.)
 * can clean up.
 *
 * Usage:
 *   const data = await withTimeout(fetch(url), TIMEOUTS.HTTP_DEFAULT, {
 *     operation: "fetch",
 *     onTimeout: () => controller.abort(),
 *   });
 */
import { TimeoutError } from "./error-taxonomy.js";

export interface WithTimeoutOptions {
  /** Identifier surfaced in the TimeoutError; defaults to "operation". */
  readonly operation?: string;
  /** Invoked when the deadline elapses (e.g. to abort an underlying request). */
  readonly onTimeout?: () => void;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  options: WithTimeoutOptions = {},
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(
      new TimeoutError(options.operation ?? "operation", timeoutMs),
    );
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        options.onTimeout?.();
      } catch {
        // onTimeout is best-effort; never let its failure mask the TimeoutError.
      }
      reject(new TimeoutError(options.operation ?? "operation", timeoutMs));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
