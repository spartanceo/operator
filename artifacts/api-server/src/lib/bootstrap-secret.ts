/**
 * Bootstrap RUNTIME_KEY_SECRET for local desktop use.
 *
 * Called from startServer() so that both the standalone process (index.ts)
 * and the Electron main process (omninity-desktop/main.ts) get the key
 * injected before routes can handle credential-save requests.
 *
 * Priority order (first match wins):
 *   1. RUNTIME_KEY_SECRET env var already set — do nothing.
 *   2. SESSION_SECRET env var already set — do nothing (credentials.ts
 *      reads it as a fallback; we don't need to copy it over).
 *   3. OS Keychain — reads from service "omninity.runtime-key" via keytar
 *      when KEYCHAIN_BACKEND=keytar is set and keytar is installed.
 *   4. ~/.omninity/.runtime-key flat file (mode 0o600) — only used when
 *      the keychain is NOT available. Never written when keychain succeeds.
 *   5. Generate a fresh 32-byte hex secret. Persist via:
 *        - Keychain only (if available)
 *        - File only (if keychain unavailable)
 *
 * Persistence is required. If neither the keychain nor the file can be
 * written, the function throws BootstrapError. This propagates through
 * startServer() so the app surfaces a clear error rather than silently
 * running with an ephemeral key that would make saved credentials
 * unreadable on the next launch.
 *
 * The keychain service "omninity.runtime-key" is intentionally distinct
 * from "omninity.runtime" used for cloud API-key storage, so the two
 * responsibilities never alias each other in the OS keychain.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OMNINITY_DIR = join(homedir(), ".omninity");
const SECRET_FILE = join(OMNINITY_DIR, ".runtime-key");

const KEYCHAIN_SERVICE = "omninity.runtime-key";
const KEYCHAIN_ACCOUNT = "encryption-master";

export class BootstrapError extends Error {
  override readonly name = "BootstrapError";
  constructor(message: string) {
    super(message);
  }
}

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

  if (keytar) {
    const fromKeychain = await keytar
      .getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
      .catch(() => null);
    if (fromKeychain && fromKeychain.length >= 32) {
      process.env["RUNTIME_KEY_SECRET"] = fromKeychain;
      return;
    }
  } else {
    const fromFile = await readFromFile();
    if (fromFile) {
      process.env["RUNTIME_KEY_SECRET"] = fromFile;
      return;
    }
  }

  const fresh = randomBytes(32).toString("hex");

  if (keytar) {
    const ok = await keytar
      .setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, fresh)
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      throw new BootstrapError(
        "Could not store the encryption key in the OS keychain — " +
          "check keychain access permissions or unset KEYCHAIN_BACKEND=keytar " +
          "to fall back to file-based persistence.",
      );
    }
  } else {
    const ok = await writeToFile(fresh);
    if (!ok) {
      throw new BootstrapError(
        "Could not persist the encryption key to " +
          SECRET_FILE +
          " — check write permissions for ~/.omninity or set RUNTIME_KEY_SECRET manually.",
      );
    }
  }

  process.env["RUNTIME_KEY_SECRET"] = fresh;
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

async function writeToFile(secret: string): Promise<boolean> {
  try {
    await mkdir(OMNINITY_DIR, { recursive: true });
    await writeFile(SECRET_FILE, secret, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
