/**
 * Safe accessor for the Vite-injected base URL.
 *
 * Vite inlines `import.meta.env.BASE_URL` at build time. In Node-side
 * test harnesses (e.g. the rendered axe-core gate in
 * `scripts/a11y-check.tsx`) `import.meta.env` is undefined per-module,
 * which crashes any component that touches `BASE_URL` directly.
 *
 * Centralising the access here lets us fall back to `"/"` in those
 * environments without scattering optional-chain noise across the call
 * sites.
 */

export function getBaseUrl(): string {
  const meta = import.meta as unknown as { env?: { BASE_URL?: string } };
  return meta.env?.BASE_URL ?? "/";
}
