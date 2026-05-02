/**
 * @workspace/errors — typed error taxonomy + resilience primitives.
 *
 * Owns: error classification (Step 1), user-message catalog (Step 6
 * foundation), retry / timeout / circuit breaker primitives (Standard 8),
 * disk-space monitor (Step 5 foundation), and the API error mapper used by
 * the api-server middleware.
 *
 * See README.md for what this package intentionally does NOT own and which
 * downstream tasks consume it.
 */
export * from "./timeouts.js";
export * from "./error-taxonomy.js";
export * from "./error-catalog.js";
export * from "./with-timeout.js";
export * from "./with-retry.js";
export * from "./circuit-breaker.js";
export * from "./disk-monitor.js";
export * from "./api-mapper.js";
