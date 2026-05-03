/**
 * Per-session cloud-confirmation tracking.
 *
 * Cloud runtime adapters (OpenAI, Anthropic) refuse to chat unless the
 * user has explicitly opted in *this session* — and the opt-in is
 * scoped per runtime id, not globally. Confirming OpenAI does NOT
 * implicitly authorise Anthropic; each cloud provider needs its own
 * approval before any traffic can leave the device.
 *
 * The set lives on the express-session cookie store; logging out (or
 * the cookie's 12h TTL) clears it and forces a fresh confirmation.
 *
 * We deliberately do NOT persist this in SQLite — the consent must be
 * re-issued on every fresh login, even on the same device.
 */
import type { Request } from "express";

const SESSION_KEY = "cloudConfirmedRuntimeIds";

function readIds(req: Request): string[] {
  const sess = req.session as unknown as Record<string, unknown> | undefined;
  const raw = sess?.[SESSION_KEY];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

function writeIds(req: Request, ids: string[]): void {
  const sess = req.session as unknown as Record<string, unknown> | undefined;
  if (sess) sess[SESSION_KEY] = ids;
}

/** Returns true only when *this specific runtime* has been confirmed. */
export function isRuntimeCloudConfirmed(req: Request, runtimeId: string): boolean {
  return readIds(req).includes(runtimeId);
}

/** Records (or revokes) confirmation for a single runtime id. */
export function setRuntimeCloudConfirmed(
  req: Request,
  runtimeId: string,
  value: boolean,
): void {
  const cur = new Set(readIds(req));
  if (value) cur.add(runtimeId);
  else cur.delete(runtimeId);
  writeIds(req, Array.from(cur));
}

/** Snapshot for diagnostics / Privacy Meter — never empty in tests. */
export function listConfirmedRuntimeIds(req: Request): string[] {
  return readIds(req);
}
