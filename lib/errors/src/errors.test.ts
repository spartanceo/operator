/**
 * Tests for @workspace/errors.
 *
 * Run via `pnpm --filter @workspace/errors run test`.
 *
 * Conventions:
 *  - Zero external dependencies — uses `node:assert/strict` and `node:test`.
 *  - One `test()` per behavioural contract; the description is the contract.
 *  - Time-sensitive tests use injectable `now` / `sleep` so they're
 *    deterministic and finish in milliseconds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TIMEOUTS,
  withTimeout,
  withRetry,
  defaultShouldRetry,
  CircuitBreaker,
  DiskMonitor,
  DISK_THRESHOLDS,
  DomainError,
  RuntimeError,
  ValidationError,
  PermissionError,
  TimeoutError,
  CircuitOpenError,
  OllamaUnavailableError,
  FileNotFoundError,
  isDomainError,
  toApiError,
  getUserMessage,
  hasUserMessage,
  knownErrorCodes,
} from "./index.js";

/* -------------------------------------------------------------------------- */
/*  TIMEOUTS                                                                  */
/* -------------------------------------------------------------------------- */

test("TIMEOUTS exposes finite positive values", () => {
  for (const [k, v] of Object.entries(TIMEOUTS)) {
    assert.ok(Number.isFinite(v), `${k} should be finite`);
    assert.ok(v > 0, `${k} should be > 0`);
  }
});

/* -------------------------------------------------------------------------- */
/*  Error taxonomy                                                            */
/* -------------------------------------------------------------------------- */

test("DomainError pins default code/status per domain", () => {
  const e = new RuntimeError("boom");
  assert.equal(e.code, "RUNTIME_ERROR");
  assert.equal(e.status, 500);
  assert.equal(e.expose, false);
  assert.equal(e.domain, "runtime");
  assert.ok(e instanceof Error);
  assert.ok(isDomainError(e));
});

test("ValidationError defaults to expose=true so the message reaches the user", () => {
  const e = new ValidationError("'name' is required");
  assert.equal(e.expose, true);
  assert.equal(e.status, 400);
});

test("PermissionError surfaces 403 / PERMISSION_DENIED", () => {
  const e = new PermissionError("camera access required");
  assert.equal(e.status, 403);
  assert.equal(e.code, "PERMISSION_DENIED");
});

test("Specialised errors carry structured details", () => {
  const t = new TimeoutError("ollama.chat", 1234);
  assert.equal(t.code, "TIMEOUT");
  assert.equal(t.status, 504);
  assert.deepEqual(t.details, { operation: "ollama.chat", timeoutMs: 1234 });

  const o = new OllamaUnavailableError();
  assert.equal(o.code, "OLLAMA_UNAVAILABLE");
  assert.equal(o.status, 503);

  const f = new FileNotFoundError("/tmp/missing");
  assert.equal(f.code, "FILE_NOT_FOUND");
  assert.equal(f.status, 404);
  assert.equal(f.expose, true);
  assert.deepEqual(f.details, { path: "/tmp/missing" });
});

test("isDomainError discriminates DomainError from plain Error", () => {
  assert.equal(isDomainError(new Error("x")), false);
  assert.equal(isDomainError(new RuntimeError("x")), true);
  assert.equal(isDomainError("string"), false);
  assert.equal(isDomainError(null), false);
});

/* -------------------------------------------------------------------------- */
/*  User-message catalog                                                      */
/* -------------------------------------------------------------------------- */

test("Every catalogued message is plain English with an action", () => {
  for (const code of knownErrorCodes()) {
    const m = getUserMessage(code);
    assert.ok(m.message.length > 0, `${code}.message empty`);
    assert.ok(m.action.length > 0, `${code}.action empty`);
    // Forbid raw codes leaking into user-facing strings.
    assert.ok(!/[A-Z_]{4,}/.test(m.message), `${code}.message contains SCREAM_CASE`);
  }
});

test("Catalog covers every default code emitted by the taxonomy", () => {
  const requiredCodes = [
    "INTERNAL",
    "RUNTIME_ERROR",
    "INVALID_INPUT",
    "UNAUTHENTICATED",
    "PERMISSION_DENIED",
    "TENANT_ISOLATION",
    "OAUTH_EXPIRED",
    "TIMEOUT",
    "CIRCUIT_OPEN",
    "NETWORK_ERROR",
    "RATE_LIMITED",
    "OLLAMA_UNAVAILABLE",
    "MODEL_ERROR",
    "MODEL_OOM",
    "TOOL_FAILED",
    "STORAGE_ERROR",
    "FILE_NOT_FOUND",
    "DISK_SPACE_LOW",
    "INTEGRATION_FAILED",
    "NOT_FOUND",
  ];
  for (const c of requiredCodes) {
    assert.equal(hasUserMessage(c), true, `missing catalog entry: ${c}`);
  }
});

test("Unknown codes resolve to the generic fallback", () => {
  const m = getUserMessage("__definitely_not_a_real_code__");
  assert.match(m.message, /went wrong/i);
});

/* -------------------------------------------------------------------------- */
/*  withTimeout                                                               */
/* -------------------------------------------------------------------------- */

test("withTimeout resolves when the inner promise settles in time", async () => {
  const value = await withTimeout(Promise.resolve(42), 1000);
  assert.equal(value, 42);
});

test("withTimeout rejects with TimeoutError when the deadline elapses", async () => {
  const slow = new Promise<never>(() => {});
  await assert.rejects(
    () => withTimeout(slow, 10, { operation: "slow" }),
    (e: unknown) => e instanceof TimeoutError && (e as TimeoutError).code === "TIMEOUT",
  );
});

test("withTimeout invokes onTimeout exactly once when the deadline elapses", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withTimeout(new Promise<never>(() => {}), 10, {
        onTimeout: () => {
          calls++;
        },
      }),
    TimeoutError,
  );
  assert.equal(calls, 1);
});

test("withTimeout rejects immediately with TimeoutError on non-positive timeout", async () => {
  await assert.rejects(() => withTimeout(Promise.resolve(1), 0), TimeoutError);
  await assert.rejects(() => withTimeout(Promise.resolve(1), -5), TimeoutError);
});

test("withTimeout swallows errors from onTimeout to preserve the TimeoutError", async () => {
  await assert.rejects(
    () =>
      withTimeout(new Promise<never>(() => {}), 5, {
        onTimeout: () => {
          throw new Error("ignored");
        },
      }),
    TimeoutError,
  );
});

/* -------------------------------------------------------------------------- */
/*  withRetry                                                                 */
/* -------------------------------------------------------------------------- */

test("withRetry returns the first successful result", async () => {
  const v = await withRetry(async () => 7, { sleep: async () => {} });
  assert.equal(v, 7);
});

test("withRetry retries on retryable failures and eventually succeeds", async () => {
  let calls = 0;
  const value = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    },
    { sleep: async () => {}, maxAttempts: 5 },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("withRetry exhausts maxAttempts and throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail-${calls}`);
        },
        { sleep: async () => {}, maxAttempts: 3 },
      ),
    /fail-3/,
  );
  assert.equal(calls, 3);
});

test("withRetry does NOT retry validation/auth/permission/tenant/tool errors", async () => {
  for (const Ctor of [ValidationError, PermissionError]) {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new Ctor("nope");
          },
          { sleep: async () => {}, maxAttempts: 5 },
        ),
      Ctor,
    );
    assert.equal(calls, 1, `${Ctor.name} should not be retried`);
  }
});

test("defaultShouldRetry retries network/runtime/integration errors", () => {
  assert.equal(defaultShouldRetry(new Error("plain"), 0), true);
  assert.equal(defaultShouldRetry(new RuntimeError("x"), 0), true);
  assert.equal(defaultShouldRetry(new TimeoutError("op", 1), 0), true);
  assert.equal(defaultShouldRetry(new ValidationError("x"), 0), false);
  assert.equal(defaultShouldRetry(new PermissionError("x"), 0), false);
});

test("withRetry calls onRetry with attempt index and computed delay", async () => {
  const events: { attempt: number; delay: number }[] = [];
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          throw new Error("x");
        },
        {
          sleep: async () => {},
          maxAttempts: 3,
          baseDelayMs: 100,
          jitter: 0,
          onRetry: (_e, attempt, delay) => {
            events.push({ attempt, delay });
          },
        },
      ),
    /x/,
  );
  // 2 retries between 3 attempts; delays = base * 2^attempt with no jitter.
  assert.deepEqual(events, [
    { attempt: 0, delay: 100 },
    { attempt: 1, delay: 200 },
  ]);
});

test("withRetry rejects RangeError if maxAttempts < 1", async () => {
  await assert.rejects(
    () => withRetry(async () => 1, { maxAttempts: 0 }),
    RangeError,
  );
});

/* -------------------------------------------------------------------------- */
/*  CircuitBreaker                                                            */
/* -------------------------------------------------------------------------- */

test("CircuitBreaker passes through calls while closed", async () => {
  const cb = new CircuitBreaker({ name: "t" });
  const v = await cb.execute(async () => 1);
  assert.equal(v, 1);
  assert.equal(cb.getState(), "closed");
});

test("CircuitBreaker trips OPEN after failure threshold within the window", async () => {
  const cb = new CircuitBreaker({
    name: "trips",
    volumeThreshold: 4,
    errorThresholdPercentage: 50,
  });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => cb.execute(async () => { throw new Error("x"); }));
  }
  assert.equal(cb.getState(), "open");
});

test("CircuitBreaker fast-fails with CircuitOpenError when open", async () => {
  const cb = new CircuitBreaker({ name: "open" });
  cb.trip();
  await assert.rejects(
    () => cb.execute(async () => 1),
    (e: unknown) => e instanceof CircuitOpenError,
  );
});

test("CircuitBreaker uses fallback in OPEN state instead of throwing", async () => {
  const cb = new CircuitBreaker({ name: "fb" }).withFallback(() => "degraded");
  cb.trip();
  const v = await cb.execute<string>(async () => "live");
  assert.equal(v, "degraded");
});

test("CircuitBreaker transitions OPEN → HALF-OPEN → CLOSED on a successful trial", async () => {
  let now = 1_000;
  const cb = new CircuitBreaker({
    name: "halfopen",
    resetTimeoutMs: 100,
    now: () => now,
  });
  cb.trip();
  assert.equal(cb.getState(), "open");

  now += 200;
  // getState() advances the breaker into half-open.
  assert.equal(cb.getState(), "half-open");

  const v = await cb.execute(async () => 99);
  assert.equal(v, 99);
  assert.equal(cb.getState(), "closed");
});

test("CircuitBreaker re-opens if the half-open trial fails", async () => {
  let now = 1_000;
  const cb = new CircuitBreaker({
    name: "halfopen-fail",
    resetTimeoutMs: 100,
    now: () => now,
  });
  cb.trip();
  now += 200;
  assert.equal(cb.getState(), "half-open");
  await assert.rejects(() => cb.execute(async () => { throw new Error("x"); }));
  assert.equal(cb.getState(), "open");
});

test("CircuitBreaker ignores stats below volumeThreshold", async () => {
  const cb = new CircuitBreaker({
    name: "vol",
    volumeThreshold: 10,
    errorThresholdPercentage: 50,
  });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => cb.execute(async () => { throw new Error("x"); }));
  }
  assert.equal(cb.getState(), "closed");
});

/* -------------------------------------------------------------------------- */
/*  DiskMonitor                                                               */
/* -------------------------------------------------------------------------- */

test("DiskMonitor classifies free space against thresholds", async () => {
  const m = new DiskMonitor({
    probe: async () => ({ freeBytes: 5 * 1024 * 1024 * 1024, totalBytes: 100e9 }),
  });
  const ok = await m.check("/tmp");
  assert.equal(ok.health, "ok");

  const m2 = new DiskMonitor({
    probe: async () => ({ freeBytes: 1 * 1024 * 1024 * 1024, totalBytes: 100e9 }),
  });
  const warn = await m2.check("/tmp");
  assert.equal(warn.health, "warning");

  const m3 = new DiskMonitor({
    probe: async () => ({ freeBytes: 100 * 1024 * 1024, totalBytes: 100e9 }),
  });
  const crit = await m3.check("/tmp");
  assert.equal(crit.health, "critical");
});

test("DiskMonitor returns 'unknown' when the probe throws", async () => {
  const m = new DiskMonitor({
    probe: async () => {
      throw new Error("statfs failed");
    },
  });
  const r = await m.check("/tmp");
  assert.equal(r.health, "unknown");
  assert.equal(r.freeBytes, null);
});

test("DiskMonitor refuses an inverted threshold configuration", () => {
  assert.throws(
    () => new DiskMonitor({ warningBytes: 100, criticalBytes: 200 }),
    RangeError,
  );
});

test("DISK_THRESHOLDS matches the spec (2GB warning, 500MB critical)", () => {
  assert.equal(DISK_THRESHOLDS.WARNING_BYTES, 2 * 1024 * 1024 * 1024);
  assert.equal(DISK_THRESHOLDS.CRITICAL_BYTES, 500 * 1024 * 1024);
});

/* -------------------------------------------------------------------------- */
/*  toApiError                                                                */
/* -------------------------------------------------------------------------- */

test("toApiError surfaces DomainError code and status", () => {
  const t = toApiError(new OllamaUnavailableError());
  assert.equal(t.code, "OLLAMA_UNAVAILABLE");
  assert.equal(t.status, 503);
  assert.match(t.message, /local AI/i);
});

test("toApiError uses raw message when DomainError opts in via expose=true", () => {
  const e = new ValidationError("'tenantId' is required");
  const t = toApiError(e);
  assert.equal(t.code, "INVALID_INPUT");
  assert.equal(t.status, 400);
  assert.equal(t.message, "'tenantId' is required");
});

test("toApiError replaces unsafe DomainError messages with the catalog message", () => {
  const e = new DomainError("runtime", "pg: connection refused at 10.0.0.5:5432");
  const t = toApiError(e);
  assert.equal(t.code, "RUNTIME_ERROR");
  // The leaky internal message must NOT pass through.
  assert.notEqual(t.message, e.message);
  assert.match(t.message, /unexpected/i);
});

test("toApiError honours Express-style { status, expose, code } errors", () => {
  const httpErr = { status: 401, expose: true, code: "UNAUTHENTICATED", message: "Token missing" };
  const t = toApiError(httpErr);
  assert.equal(t.status, 401);
  assert.equal(t.code, "UNAUTHENTICATED");
  assert.equal(t.message, "Token missing");
});

test("toApiError collapses truly unknown values to safe INTERNAL", () => {
  const t = toApiError("bare string");
  assert.equal(t.code, "INTERNAL");
  assert.equal(t.status, 500);
  assert.match(t.message, /went wrong/i);
  assert.equal(t.cause, "bare string");
});

test("toApiError preserves the original error on .cause for logging", () => {
  const original = new Error("with internal hostnames postgres://prod-db");
  const t = toApiError(original);
  assert.equal(t.cause, original);
});

test("toApiError carries DomainError details through to the triple", () => {
  const e = new TimeoutError("ollama.chat", 60_000);
  const t = toApiError(e);
  assert.deepEqual(t.details, { operation: "ollama.chat", timeoutMs: 60_000 });
});
