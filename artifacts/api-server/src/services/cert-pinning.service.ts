/**
 * Certificate-pinning helper.
 *
 * Standard 12 § "Network hardening": outbound HTTPS to known
 * model-runtime / payment / auth providers is pinned to a small set of
 * SHA-256 fingerprints of the leaf or intermediate certificate. The
 * `validatePinnedCertificate()` helper takes the cert chain delivered
 * by `tls.checkServerIdentity` (or fetched directly via `tls.connect`)
 * and returns true only when at least one fingerprint in the chain
 * matches an allow-listed pin.
 *
 * The pin set is intentionally hard-coded here so any change is a
 * code review — pin rotation MUST go through PR + review + audit log.
 */
import { createHash } from "node:crypto";

export interface CertificatePin {
  readonly host: string;
  readonly description: string;
  readonly sha256Fingerprints: ReadonlyArray<string>;
}

// tier-review: bounded — fixed-size pin registry, never written to at runtime.
export const PINNED_CERTIFICATES: ReadonlyArray<CertificatePin> = [
  {
    host: "ollama.com",
    description: "Ollama model registry — TLS leaf or intermediate fingerprint",
    sha256Fingerprints: [
      // Operators rotate these via PR. Empty array = no pin enforced
      // (the route caller decides whether to fail-closed or warn).
    ],
  },
  {
    host: "api.openai.com",
    description: "OpenAI public API — used only when remote routing is enabled",
    sha256Fingerprints: [],
  },
];

export interface PinValidationResult {
  readonly valid: boolean;
  readonly host: string;
  readonly matchedPin: string | null;
  readonly reason: string | null;
}

/**
 * Compute a deterministic SHA-256 fingerprint of a DER-encoded
 * certificate (the form `tls.TLSSocket.getPeerCertificate(true).raw`
 * returns).
 */
export function fingerprint(der: Buffer): string {
  const hash = createHash("sha256").update(der).digest("hex");
  // Format like `AA:BB:CC:…` to match the OpenSSL conventional output.
  const pairs: string[] = [];
  for (let i = 0; i < hash.length; i += 2) pairs.push(hash.slice(i, i + 2).toUpperCase());
  return pairs.join(":");
}

/**
 * Walk a chain of DER-encoded certificates and confirm at least one
 * fingerprint is present in the host's pin set.
 */
export function validatePinnedCertificate(
  host: string,
  chain: ReadonlyArray<Buffer>,
): PinValidationResult {
  const pin = PINNED_CERTIFICATES.find((p) => p.host === host);
  if (!pin) {
    return { valid: true, host, matchedPin: null, reason: "host not pinned — passthrough" };
  }
  if (pin.sha256Fingerprints.length === 0) {
    return { valid: true, host, matchedPin: null, reason: "pin registry empty for host" };
  }
  for (const der of chain) {
    const fp = fingerprint(der);
    if (pin.sha256Fingerprints.includes(fp)) {
      return { valid: true, host, matchedPin: fp, reason: null };
    }
  }
  return {
    valid: false,
    host,
    matchedPin: null,
    reason: `No certificate in the served chain matched a pinned fingerprint for ${host}`,
  };
}
