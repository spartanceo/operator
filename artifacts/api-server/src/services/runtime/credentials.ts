/**
 * Cloud-runtime credential storage.
 *
 * Storage strategy (in priority order):
 *   1. **OS keychain** — when a native keychain backend is available
 *      (`KEYCHAIN_BACKEND=keytar` and the optional `keytar` package is
 *      installed). Keys never touch SQLite in this mode. This is the
 *      preferred path for desktop / single-user installs.
 *   2. **AES-256-GCM encrypted at rest in SQLite** — fallback for
 *      headless / multi-tenant deployments where no OS keychain exists
 *      (Linux containers without libsecret, CI, etc).
 *
 * Either way, the master encryption secret MUST be supplied via the
 * `RUNTIME_KEY_SECRET` environment variable. There is **no** hardcoded
 * fallback — if the secret is missing the encrypt/decrypt helpers throw
 * synchronously so an operator can't accidentally roll a deployment
 * with predictable keys. (`SESSION_SECRET` is accepted as a secondary
 * source for single-process installs that already require it.)
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

export class RuntimeKeySecretMissingError extends Error {
  override readonly name = "RuntimeKeySecretMissingError";
  readonly code = "RUNTIME_KEY_SECRET_MISSING";
  readonly status = 503;
  readonly expose = true;
  constructor() {
    super(
      "Cannot encrypt cloud runtime credentials — set RUNTIME_KEY_SECRET (or SESSION_SECRET) to a 32+ char random value. There is no built-in fallback by design.",
    );
  }
}

function deriveKey(): Buffer {
  const secret = process.env["RUNTIME_KEY_SECRET"] ?? process.env["SESSION_SECRET"] ?? "";
  if (secret.length < 16) {
    // Hard-fail rather than degrade — a weak key would make the
    // encrypted blobs trivially decryptable.
    throw new RuntimeKeySecretMissingError();
  }
  return createHash("sha256").update(secret).digest();
}

export interface EncryptedCredential {
  encryptedKey: string;
  iv: string;
  authTag: string;
}

export function encryptApiKey(plaintext: string): EncryptedCredential {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedKey: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptApiKey(blob: EncryptedCredential): string {
  const decipher = createDecipheriv(ALGO, deriveKey(), Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(blob.encryptedKey, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Native OS keychain bridge.
 *
 * We resolve `keytar` lazily so the package can be installed only on
 * platforms where it builds (macOS, Windows, Linux+libsecret). When
 * `keytar` is absent the bridge reports `available=false` and the
 * caller falls back to encrypted SQLite storage.
 */
const KEYCHAIN_SERVICE = "omninity.runtime";

interface KeychainBridge {
  available: boolean;
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | null>;
  del(account: string): Promise<void>;
}

let _bridge: KeychainBridge | null = null;

export async function keychainBridge(): Promise<KeychainBridge> {
  if (_bridge) return _bridge;
  if (process.env["KEYCHAIN_BACKEND"] !== "keytar") {
    _bridge = {
      available: false,
      set: async () => {},
      get: async () => null,
      del: async () => {},
    };
    return _bridge;
  }
  try {
    // Optional dep — installed only on supported platforms. The dynamic
    // import keeps `keytar` from being bundled when absent. The
    // ts-ignore is required because `keytar` is intentionally NOT in
    // package.json — operators install it themselves on hosts where it
    // builds.
    // @ts-ignore — optional native dep, may be absent
    const mod = (await import(/* @vite-ignore */ "keytar")) as {
      setPassword(s: string, a: string, p: string): Promise<void>;
      getPassword(s: string, a: string): Promise<string | null>;
      deletePassword(s: string, a: string): Promise<boolean>;
    };
    _bridge = {
      available: true,
      set: (a, s) => mod.setPassword(KEYCHAIN_SERVICE, a, s),
      get: (a) => mod.getPassword(KEYCHAIN_SERVICE, a),
      del: async (a) => {
        await mod.deletePassword(KEYCHAIN_SERVICE, a);
      },
    };
  } catch {
    _bridge = {
      available: false,
      set: async () => {},
      get: async () => null,
      del: async () => {},
    };
  }
  return _bridge;
}
