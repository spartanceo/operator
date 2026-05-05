/**
 * Security configuration centralised in one file (Standard 12).
 *
 * All values are derived here so an audit can answer "what hosts can talk
 * to this server, what does the CSP allow, where do credentials live" by
 * reading a single module.
 */

/**
 * Hosts allowed to make CORS requests against the api-server. Defaults to
 * the local-first set (Electron renderer + Vite dev server). The
 * `ALLOWED_ORIGINS` env var is the single overridable knob — comma-separated
 * list of fully-qualified origins.
 *
 * `*` is forbidden by Standard 12 (`Forbidden Patterns → Network laxity`).
 * If a deployer needs more origins they list them explicitly.
 */
export function allowedOrigins(): string[] {
  const fromEnv = process.env["ALLOWED_ORIGINS"];
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Default development allowlist: Vite dev server (any port) + Electron renderer.
  // The port is dynamic (assigned via PORT env var) so we derive it at runtime.
  const devPort = process.env["PORT"] ?? "5173";
  return [
    `http://127.0.0.1:${devPort}`,
    `http://localhost:${devPort}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "app://omninity-operator",
  ];
}

/**
 * Bind host. Standard 12 requires `127.0.0.1` — the api-server is the
 * loopback HTTP transport between the renderer and the local backend, never
 * a network-reachable service. Override with `HOST` only for the rare
 * case (e.g. running inside a container where the proxy lives on a
 * different interface).
 */
export function bindHost(): string {
  return process.env["HOST"] ?? "127.0.0.1";
}

/**
 * CSP source list. Locked to `'self'` plus the trusted local-first origins:
 *   - Ollama on localhost (model invocation)
 *   - Stripe + Resend if configured (billing + transactional email)
 */
export function cspDirectives(): Record<string, string[]> {
  const ollama = process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
  return {
    defaultSrc: ["'self'"],
    connectSrc: [
      "'self'",
      ollama,
      "https://api.stripe.com",
      "https://api.resend.com",
    ],
    imgSrc: ["'self'", "data:", "blob:"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    fontSrc: ["'self'", "data:"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
  };
}
