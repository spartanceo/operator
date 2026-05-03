/**
 * Log sanitiser — Standard 12.
 *
 * Strips anything that should never appear in a log line, on disk, or in a
 * support-bundle export:
 *   - credential-shaped keys (token, secret, password, api_key, ...)
 *   - `Authorization: Bearer ...` / `X-Api-Key: ...` header values
 *   - free-form strings that match credential patterns (long base64, jwt, ...)
 *   - file paths that live outside the Omninity-Operator home directory
 *   - reserved "user content" fields (`prompt`, `response`, `userContent`,
 *     `screenshot`, `clipboard`) — agent traces capture these in a separate
 *     audit channel; they must never reach an ops log.
 *
 * Mutates a deep clone — the input object is never modified, so callers can
 * keep using their original reference.
 */
import path from "node:path";

const REDACTED = "[REDACTED]" as const;

const CREDENTIAL_KEY_RE =
  /(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|bearer|authorization|cookie|set-cookie|session[_-]?id|x-api-key|client[_-]?secret|private[_-]?key|sshkey|ssh[_-]?key|otp|mfa|totp|credit[_-]?card|cardnumber|cvv|ssn|tax[_-]?id)/i;

const USER_CONTENT_KEY_RE =
  /^(prompt|response|message|completion|userContent|user_content|screenshot|screencap|clipboard|fileContent|file_content|body|payload)$/i;

const BEARER_RE = /(bearer\s+)([A-Za-z0-9._\-+/=]{16,})/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SK_RE = /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g;
const LONG_HEX_RE = /\b[a-f0-9]{40,}\b/gi;
const LONG_B64_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

/**
 * Returns the configured Omninity home directory. Logs may reference paths
 * inside this directory; anything outside (the user's documents, drives,
 * etc.) is replaced with `[EXTERNAL_PATH]`.
 */
export function opHome(): string {
  return path.resolve(
    process.env["OP_HOME"] ?? path.join(process.cwd(), ".omninity"),
  );
}

function isInsideOpHome(p: string, home: string): boolean {
  const resolved = path.resolve(p);
  const rel = path.relative(home, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const PATH_RE = /(?:[A-Za-z]:\\|\/)[^\s'"`,;()<>]{2,}/g;

function scrubPathsInString(input: string, home: string): string {
  return input.replace(PATH_RE, (match) => {
    if (isInsideOpHome(match, home)) return match;
    return "[EXTERNAL_PATH]";
  });
}

function scrubCredentialsInString(input: string): string {
  return input
    .replace(BEARER_RE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(SK_RE, REDACTED)
    .replace(LONG_HEX_RE, REDACTED)
    .replace(LONG_B64_RE, REDACTED);
}

function scrubString(input: string, home: string): string {
  return scrubPathsInString(scrubCredentialsInString(input), home);
}

/**
 * Recursively sanitises any value. Cycles are broken via a WeakSet.
 * Maximum depth defaults to 12 — beyond that the value is collapsed to
 * `[DEEP]` to keep log writes bounded.
 */
export function sanitise<T>(input: T, depthLimit = 12): T {
  const home = opHome();
  const seen = new WeakSet<object>();

  function walk(value: unknown, depth: number): unknown {
    if (depth > depthLimit) return "[DEEP]";
    if (value === null || value === undefined) return value;

    const t = typeof value;
    if (t === "string") return scrubString(value as string, home);
    if (t === "number" || t === "boolean" || t === "bigint") return value;
    if (t === "function" || t === "symbol") return undefined;

    if (value instanceof Error) {
      return {
        name: value.name,
        message: scrubString(value.message, home),
        stack:
          typeof value.stack === "string"
            ? scrubString(value.stack, home)
            : undefined,
      };
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) return "[CYCLE]";
      seen.add(value);
      return value.map((v) => walk(v, depth + 1));
    }

    if (t === "object") {
      const obj = value as Record<string, unknown>;
      if (seen.has(obj)) return "[CYCLE]";
      seen.add(obj);
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(obj)) {
        if (USER_CONTENT_KEY_RE.test(key)) {
          out[key] = REDACTED;
          continue;
        }
        if (CREDENTIAL_KEY_RE.test(key)) {
          out[key] = REDACTED;
          continue;
        }
        out[key] = walk(raw, depth + 1);
      }
      return out;
    }

    return value;
  }

  return walk(input, 0) as T;
}

/**
 * Convenience exports for tests + bundle generator.
 */
export const _testHelpers = {
  scrubString,
  scrubCredentialsInString,
  scrubPathsInString,
  isInsideOpHome,
};
