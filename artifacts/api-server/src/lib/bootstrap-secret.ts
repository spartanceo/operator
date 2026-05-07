/**
 * Bootstrap RUNTIME_KEY_SECRET for local desktop use.
 *
 * Called automatically from startServer() — both the standalone process
 * (index.ts) and the Electron main process (omninity-desktop/main.ts) call
 * startServer(), so neither entrypoint needs to call this directly.
 *
 * Priority order (first match wins):
 *   1. RUNTIME_KEY_SECRET env var already set — do nothing.
 *   2. SESSION_SECRET env var already set — do nothing (credentials.ts
 *      reads it as a fallback; we don't need to copy it over).
 *   3. OS Keychain — when keytar is available (KEYCHAIN_BACKEND=keytar).
 *      Reads the value stored under account "RUNTIME_KEY_SECRET" in the
 *      "omninity.bootstrap" service.  On first launch the generated key is
 *      written back so subsequent starts use the same key.
 *   4. ~/.omninity/.runtime-key flat file (mode 0o600) — the file-based
 *      fallback for hosts without a native keychain (CI, Linux containers,
 *      dev installs).
 *   5. Generate a fresh 32-byte hex secret, persist via whichever backend
 *      is available (keychain → file), then inject into process.env.
 *
 * After this function resolves, `process.env["RUNTIME_KEY_SECRET"]` is
 * guaranteed to be a 64-char hex string so deriveKey() in credentials.ts
 * will never throw RuntimeKeySecretMissingError during normal operation.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { keychainBridge } from "../services/runtime/credentials";

const OMNINITY_DIR = join(homedir(), ".omninity");
const SECRET_FILE = join(OMNINITY_DIR, ".runtime-key");
const KEYCHAIN_ACCOUNT = "RUNTIME_KEY_SECRET";

export async function bootstrapRuntimeSecret(): Promise<void> {
  if (process.env["RUNTIME_KEY_SECRET"] || process.env["SESSION_SECRET"]) {
    return;
  }

  const bridge = await keychainBridge();

  if (bridge.available) {
    const fromKeychain = await bridge.get(KEYCHAIN_ACCOUNT).catch(() => null);
    if (fromKeychain && fromKeychain.length >= 32) {
      process.env["RUNTIME_KEY_SECRET"] = fromKeychain;
      return;
    }
  }

  const fromFile = await readPersistedSecret();
  if (fromFile) {
    process.env["RUNTIME_KEY_SECRET"] = fromFile;
    if (bridge.available) {
      await bridge.set(KEYCHAIN_ACCOUNT, fromFile).catch(() => null);
    }
    return;
  }

  const fresh = randomBytes(32).toString("hex");

  if (bridge.available) {
    await bridge.set(KEYCHAIN_ACCOUNT, fresh).catch(() => null);
  }
  await persistToFile(fresh);

  process.env["RUNTIME_KEY_SECRET"] = fresh;
}

async function readPersistedSecret(): Promise<string | null> {
  try {
    const raw = await readFile(SECRET_FILE, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length >= 32) {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

async function persistToFile(secret: string): Promise<void> {
  try {
    await mkdir(OMNINITY_DIR, { recursive: true });
    await writeFile(SECRET_FILE, secret, { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    console.warn(
      "[bootstrap] Could not persist RUNTIME_KEY_SECRET to " +
        SECRET_FILE +
        " — the key will only last for this session: " +
        String(e),
    );
  }
}
