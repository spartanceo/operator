/**
 * Bootstrap RUNTIME_KEY_SECRET for local desktop use.
 *
 * Priority order (first match wins):
 *   1. RUNTIME_KEY_SECRET env var already set — do nothing.
 *   2. SESSION_SECRET env var already set — do nothing (credentials.ts
 *      reads it as a fallback; we don't need to copy it over).
 *   3. Read from ~/.omninity/.runtime-key (persisted from a previous run).
 *   4. Generate a fresh 32-byte hex secret, write to ~/.omninity/.runtime-key,
 *      then inject into process.env["RUNTIME_KEY_SECRET"] for this session.
 *
 * After this function resolves, `process.env["RUNTIME_KEY_SECRET"]` is
 * guaranteed to be a 64-char hex string so `deriveKey()` in credentials.ts
 * will never throw RuntimeKeySecretMissingError during normal operation.
 *
 * The secret file is written with mode 0o600 (owner read/write only) so
 * other local accounts cannot read it.  This is the standard pattern for
 * local-first desktop apps — the user should never have to set encryption
 * keys manually.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OMNINITY_DIR = join(homedir(), ".omninity");
const SECRET_FILE = join(OMNINITY_DIR, ".runtime-key");

export async function bootstrapRuntimeSecret(): Promise<void> {
  if (process.env["RUNTIME_KEY_SECRET"] || process.env["SESSION_SECRET"]) {
    return;
  }

  const persisted = await readPersistedSecret();
  if (persisted) {
    process.env["RUNTIME_KEY_SECRET"] = persisted;
    return;
  }

  const fresh = randomBytes(32).toString("hex");
  await persistSecret(fresh);
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

async function persistSecret(secret: string): Promise<void> {
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
