/**
 * Bootstrap RUNTIME_KEY_SECRET for local desktop use.
 *
 * Called from startServer() so that both the standalone process (index.ts)
 * and the Electron main process (omninity-desktop/main.ts) get the key
 * injected before routes can handle credential-save requests.
 *
 * Read phase — priority order (first match wins):
 *   1. RUNTIME_KEY_SECRET env var already set — return immediately.
 *   2. SESSION_SECRET env var already set — return immediately (credentials.ts
 *      reads it as a fallback).
 *   3. OS Keychain — reads from service "omninity.runtime-key" via keytar when
 *      KEYCHAIN_BACKEND=keytar and the native module is installed.
 *   4. ~/.omninity/.runtime-key flat file (mode 0o600) — checked regardless
 *      of whether keytar is present, so an existing file is always reused
 *      (preserves key continuity if the keychain backend changes).
 *
 * Generate + persist phase (when no persisted key is found):
 *   5. Generate a fresh randomBytes(32).toString("hex") secret.
 *   6. Try to persist in order: keychain → file. The first success wins; the
 *      other backend is not written to (avoids dual-persistence when keychain
 *      is available).
 *   7. If keychain write fails, fall back to file (not an error).
 *   8. If both backends fail, log a warning and do NOT set
 *      process.env["RUNTIME_KEY_SECRET"]. The server starts normally and the
 *      credential-save routes surface a structured RUNTIME_KEY_SECRET_MISSING
 *      503 so the user sees a clear error rather than a crash.
 *
 * The keychain service "omninity.runtime-key" is intentionally distinct from
 * "omninity.runtime" (cloud API-key storage) so the two never alias each other
 * in the OS keychain.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OMNINITY_DIR = join(homedir(), ".omninity");
const SECRET_FILE = join(OMNINITY_DIR, ".runtime-key");

const KEYCHAIN_SERVICE = "omninity.runtime-key";
const KEYCHAIN_ACCOUNT = "encryption-master";

interface KeytarMod {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

async function loadKeytar(): Promise<KeytarMod | null> {
  if (process.env["KEYCHAIN_BACKEND"] !== "keytar") return null;
  try {
    // Optional native dep — installed only on platforms where it builds.
    // @ts-ignore — optional dep, may be absent
    return (await import(/* @vite-ignore */ "keytar")) as KeytarMod;
  } catch {
    return null;
  }
}

export async function bootstrapRuntimeSecret(): Promise<void> {
  if (process.env["RUNTIME_KEY_SECRET"] || process.env["SESSION_SECRET"]) {
    return;
  }

  const keytar = await loadKeytar();

  // ── Read phase ────────────────────────────────────────────────────────────
  // Always probe keychain first, then fall back to file — regardless of which
  // backend is preferred for writes. This preserves decryption continuity if
  // the backend changes between launches.

  if (keytar) {
    const fromKeychain = await keytar
      .getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
      .catch(() => null);
    if (fromKeychain && fromKeychain.length >= 32) {
      process.env["RUNTIME_KEY_SECRET"] = fromKeychain;
      return;
    }
  }

  const fromFile = await readFromFile();
  if (fromFile) {
    process.env["RUNTIME_KEY_SECRET"] = fromFile;
    return;
  }

  // ── Generate + persist phase ──────────────────────────────────────────────
  const fresh = randomBytes(32).toString("hex");

  const persisted = await persistSecret(fresh, keytar);

  if (persisted) {
    process.env["RUNTIME_KEY_SECRET"] = fresh;
  } else {
    // Neither backend was writable. The server still starts so that
    // credential-save routes can respond with a structured 503 (code
    // RUNTIME_KEY_SECRET_MISSING) rather than the process crashing.
    // The user will see the amber warning in the UI when they try to save
    // a cloud API key.
    console.warn(
      "[bootstrap] Could not persist RUNTIME_KEY_SECRET to either keychain or " +
        SECRET_FILE +
        ". Saving cloud API keys will fail until this is resolved. " +
        "Fix: ensure ~/.omninity is writable, or set RUNTIME_KEY_SECRET manually.",
    );
  }
}

async function readFromFile(): Promise<string | null> {
  try {
    const raw = await readFile(SECRET_FILE, "utf8");
    const trimmed = raw.trim();
    return trimmed.length >= 32 ? trimmed : null;
  } catch {
    return null;
  }
}

async function persistSecret(secret: string, keytar: KeytarMod | null): Promise<boolean> {
  if (keytar) {
    const keychainOk = await keytar
      .setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, secret)
      .then(() => true)
      .catch(() => false);
    if (keychainOk) return true;
    // Keychain write failed — fall back to file.
  }

  return writeToFile(secret);
}

async function writeToFile(secret: string): Promise<boolean> {
  try {
    await mkdir(OMNINITY_DIR, { recursive: true });
    await writeFile(SECRET_FILE, secret, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
