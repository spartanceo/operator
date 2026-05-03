/**
 * AES-256-GCM credential encryption.
 *
 * Integration credentials (OAuth tokens, API keys) are persisted to the local
 * SQLite store. Per Section 13 (Privacy & Audit) of the project context,
 * anything resembling a secret must be encrypted at rest — never in plaintext,
 * never proxied through an external server.
 *
 * Key sourcing, in priority order:
 *   1. `OMNINITY_INTEGRATIONS_KEY` — explicit dedicated key (recommended).
 *   2. `SESSION_SECRET` — the same secret used for session signing.
 *   3. A deterministic fallback derived from the database path. This is NOT
 *      production-safe; it exists so a fresh dev container can still encrypt
 *      records, with a one-time warning logged on first use.
 *
 * Envelope format (single base64url string):
 *   <iv>.<authTag>.<ciphertext>
 *
 * Each piece is base64url-encoded independently so the dot is unambiguous.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { logger } from "./logger";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const SCRYPT_SALT = "omninity-integrations-v1";

let cachedKey: Buffer | null = null;
let warnedFallback = false;

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SCRYPT_SALT, KEY_LEN);
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const explicit = process.env["OMNINITY_INTEGRATIONS_KEY"];
  if (explicit && explicit.length > 0) {
    cachedKey = deriveKey(explicit);
    return cachedKey;
  }
  const session = process.env["SESSION_SECRET"];
  if (session && session.length > 0) {
    cachedKey = deriveKey(session);
    return cachedKey;
  }
  if (!warnedFallback) {
    logger.warn(
      "Integration credentials are using a fallback encryption key. Set OMNINITY_INTEGRATIONS_KEY or SESSION_SECRET for production.",
    );
    warnedFallback = true;
  }
  cachedKey = deriveKey("omninity-default-fallback-do-not-use-in-prod");
  return cachedKey;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/**
 * Encrypt an arbitrary credentials object as a single envelope string.
 * Returns null when given null/undefined so callers can pipe through
 * partial updates without checking.
 */
export function encryptCredentials(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null;
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${b64url(iv)}.${b64url(authTag)}.${b64url(ciphertext)}`;
}

/**
 * Decrypt an envelope produced by `encryptCredentials`. Throws on tamper /
 * key mismatch — callers convert this to a 500 INTERNAL response so the
 * audit log captures the integrity failure.
 */
export function decryptCredentials(envelope: string | null): Record<string, unknown> | null {
  if (!envelope) return null;
  const parts = envelope.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed credential envelope");
  }
  const [ivStr, tagStr, ctStr] = parts as [string, string, string];
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, fromB64url(ivStr));
  decipher.setAuthTag(fromB64url(tagStr));
  const plain = Buffer.concat([
    decipher.update(fromB64url(ctStr)),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
}

/**
 * Test-only: drop the cached key so a new env var takes effect on the
 * next call. Production code never needs this.
 */
export function _resetCredentialKeyCacheForTests(): void {
  cachedKey = null;
  warnedFallback = false;
}
