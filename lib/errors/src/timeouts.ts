/**
 * Canonical timeout constants — Standard 8 of the project context.
 *
 * Define once, use everywhere. Every external call MUST use a timeout from
 * this map; no `await fetch(...)` without a timeout wrapper. Adding a new
 * external system means adding a constant here, not a magic number at the
 * call site.
 *
 * All values are milliseconds.
 */
export const TIMEOUTS = {
  /** Ollama inference call — LLMs can be slow. */
  OLLAMA_INFERENCE: 60_000,
  /** Ollama health/liveness probe — must be fast. */
  OLLAMA_HEALTH: 3_000,
  /** Stripe REST API call. */
  STRIPE_API: 10_000,
  /** Resend (transactional email) API call. */
  RESEND_API: 5_000,
  /** Electron main↔renderer IPC round-trip. */
  ELECTRON_IPC: 5_000,
  /** Single skill execution budget. */
  SKILL_EXECUTION: 30_000,
  /** Single LAV (Local Action Vector) desktop action. */
  DESKTOP_ACTION: 15_000,
  /** Generic outbound HTTP fetch when the destination has no dedicated entry. */
  HTTP_DEFAULT: 10_000,
  /** Database query — Postgres roundtrip. */
  DB_QUERY: 5_000,
} as const;

export type TimeoutKey = keyof typeof TIMEOUTS;
