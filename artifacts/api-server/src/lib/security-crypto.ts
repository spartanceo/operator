/**
 * Security crypto primitives — the only place we instantiate hashes,
 * signatures, KDFs, or secret comparisons. Standard 12 § "Crypto":
 * keep these in one file so a swap to a different library (e.g. argon2
 * once it ships natively, libsodium for HMAC) is a single-file change.
 *
 * Algorithm choices:
 *   - SHA-256          — audit hash chain (fast, well-supported, the
 *                        chain provides tamper detection, not secrecy).
 *   - HMAC-SHA-256     — webhook signatures (the de-facto standard for
 *                        Stripe / Resend / Slack-style integrations).
 *   - scrypt           — password KDF. node:crypto ships it natively;
 *                        we use it as the Argon2id stand-in. The schema
 *                        records `kdf_algo` so a future migration can
 *                        roll forward to argon2id without losing the
 *                        ability to verify legacy hashes.
 *   - AES-256-GCM      — symmetric envelope for vault entries.
 *   - HMAC-SHA-1 (TOTP) — RFC 6238 compliance; SHA-1 is the algorithm
 *                         every authenticator app speaks.
 *
 * Constant-time equality is mandatory for any secret comparison —
 * `===` leaks timing information. `crypto.timingSafeEqual` is the
 * single allowed comparator.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// ──────────────────────────────────────────────────────────────────────────
// Hash chain (audit log)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Canonicalise an arbitrary record into a deterministic JSON string.
 * Sorted keys mean two clients producing the same logical payload always
 * compute the same hash regardless of insertion order.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`)
    .join(",")}}`;
}

/**
 * Compute the next entry hash in an audit chain. Genesis entries pass
 * `previousHash = null`; the chain is anchored to the empty string in
 * that case so the first row's hash is reproducible.
 */
export function hashChainNext(
  previousHash: string | null,
  payload: unknown,
): string {
  const prev = previousHash ?? "";
  const body = canonicalise(payload);
  return createHash("sha256").update(`${prev}\n${body}`).digest("hex");
}

export interface HashChainRow {
  readonly previousHash: string | null;
  readonly entryHash: string;
  readonly payload: unknown;
}

/**
 * Walk a list of audit rows in order and return the index of the first
 * row whose hash does not match its declared payload + previous hash.
 * Returns `null` if the chain is intact.
 */
export function verifyHashChain(rows: readonly HashChainRow[]): number | null {
  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.previousHash !== prev) return i;
    const expected = hashChainNext(prev, row.payload);
    if (expected !== row.entryHash) return i;
    prev = row.entryHash;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// HMAC (webhooks)
// ──────────────────────────────────────────────────────────────────────────

export function hmacSign(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

/**
 * Constant-time HMAC verification. Returns false on any mismatch,
 * including length differences (constructing two equal-length buffers
 * before the timingSafeEqual call so the comparator never throws).
 */
export function hmacVerify(
  key: string,
  payload: string,
  signature: string,
): boolean {
  const expected = hmacSign(key, payload);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Password KDF (master password, refresh-token hashing)
// ──────────────────────────────────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;

export interface PasswordHash {
  readonly algo: string;
  readonly salt: string;
  readonly hash: string;
}

export function kdfHashPassword(plain: string, salt?: string): PasswordHash {
  const useSalt = salt ?? randomBytes(16).toString("hex");
  const buf = scryptSync(plain, useSalt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return {
    algo: `scrypt-n${SCRYPT_N}-r${SCRYPT_R}-p${SCRYPT_P}`,
    salt: useSalt,
    hash: buf.toString("hex"),
  };
}

export function kdfVerifyPassword(plain: string, stored: PasswordHash): boolean {
  const candidate = kdfHashPassword(plain, stored.salt);
  const a = Buffer.from(candidate.hash, "hex");
  const b = Buffer.from(stored.hash, "hex");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Symmetric envelope (vault)
// ──────────────────────────────────────────────────────────────────────────

export interface SealedSecret {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

/**
 * Derive a 32-byte AES key from the master password + a per-namespace salt.
 */
export function deriveVaultKey(masterPassword: string, namespace: string): Buffer {
  return scryptSync(masterPassword, `omninity-vault:${namespace}`, 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

// AES-256-GCM auth tag length in bytes. Pinning this at construction
// time hardens against truncation attacks where an attacker tries to
// pass a shorter tag the runtime would otherwise accept (semgrep
// gcm-no-tag-length).
const GCM_AUTH_TAG_LENGTH = 16;

export function sealSecret(key: Buffer, plaintext: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString("hex"),
    iv: iv.toString("hex"),
    authTag: tag.toString("hex"),
  };
}

export function openSecret(key: Buffer, sealed: SealedSecret): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "hex"),
    { authTagLength: GCM_AUTH_TAG_LENGTH },
  );
  const tagBuf = Buffer.from(sealed.authTag, "hex");
  if (tagBuf.length !== GCM_AUTH_TAG_LENGTH) {
    throw new Error(
      `Sealed secret has wrong auth tag length: ${tagBuf.length} (expected ${GCM_AUTH_TAG_LENGTH})`,
    );
  }
  decipher.setAuthTag(tagBuf);
  const pt = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "hex")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

// ──────────────────────────────────────────────────────────────────────────
// Secure memory wipe — best-effort. Node's GC means we can never fully
// guarantee wiping, but Buffer.fill closes the most common leak (a
// long-lived Buffer instance still holding plaintext after the caller
// "forgot" it).
// ──────────────────────────────────────────────────────────────────────────

export function secureMemoryWipe(buf: Buffer): void {
  if (Buffer.isBuffer(buf) && buf.length > 0) {
    buf.fill(0);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// TOTP (RFC 6238) — admin 2FA
// ──────────────────────────────────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(byteLength: number = 20): string {
  const bytes = randomBytes(byteLength);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(secret: string): Buffer {
  const cleaned = secret.replace(/=+$/, "").toUpperCase();
  let bits = "";
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 char "${ch}"`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    out.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(out);
}

function totpComputeCode(secret: string, counter: number, digits: number = 6): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  // Big-endian 64-bit counter; JS bitwise ops are 32-bit so split.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  const mod = 10 ** digits;
  return (code % mod).toString().padStart(digits, "0");
}

/**
 * Compute the current 6-digit TOTP code for a base32 secret. Exposed so
 * test suites and provisioning UIs can render the active code; callers
 * authenticating users MUST go through {@link totpVerify} so the
 * constant-time comparison + drift-window logic stays centralised.
 */
export function totpCurrentCode(secret: string, now: number = Date.now()): string {
  return totpComputeCode(secret, Math.floor(now / 30_000));
}

export interface TotpVerifyResult {
  readonly valid: boolean;
  readonly counter: number | null;
}

/**
 * Verify a TOTP code against a base32 secret. Allows a `drift`-window of
 * 30-second steps either side of "now" so a user with a slightly skewed
 * clock isn't locked out. Returns the matching counter so the caller can
 * persist `lastUsedCounter` and reject replay of the same code.
 */
export function totpVerify(
  secret: string,
  code: string,
  drift: number = 1,
  now: number = Date.now(),
): TotpVerifyResult {
  if (!/^\d{6}$/.test(code)) return { valid: false, counter: null };
  const step = 30_000;
  const baseCounter = Math.floor(now / step);
  for (let offset = -drift; offset <= drift; offset++) {
    const counter = baseCounter + offset;
    if (counter < 0) continue;
    const candidate = totpComputeCode(secret, counter);
    const a = Buffer.from(candidate, "utf8");
    const b = Buffer.from(code, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { valid: true, counter };
    }
  }
  return { valid: false, counter: null };
}

// ──────────────────────────────────────────────────────────────────────────
// Refresh-token hashing — SHA-256 (no KDF needed; the token is already a
// 256-bit random value, the hash exists only to keep the DB column from
// holding a usable bearer credential at rest).
// ──────────────────────────────────────────────────────────────────────────

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateOpaqueToken(byteLength: number = 32): string {
  return randomBytes(byteLength).toString("base64url");
}
