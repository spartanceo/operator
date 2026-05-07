/**
 * Shared helpers for reading the canonical API error envelope.
 *
 * The server always returns failures as:
 *   { success: false, error: { code: string, message: string } }
 *
 * These helpers ensure every fetch call-site reads the same field path
 * instead of duplicating inline casts that silently return `undefined`.
 */

/**
 * Extracts a human-readable error message from a raw JSON response body.
 *
 * Reads `body.error.message` (the canonical envelope field) and falls back
 * to `fallback` when the body is absent, malformed, or the message is empty.
 */
export function extractApiErrorMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object") {
    const b = body as { error?: { message?: unknown } };
    if (typeof b.error?.message === "string" && b.error.message.length > 0) {
      return b.error.message;
    }
  }
  return fallback;
}

/**
 * Extracts the error code from a raw JSON response body.
 *
 * Reads `body.error.code` (the canonical envelope field) and returns null
 * when the body is absent, malformed, or the code field is missing.
 */
export function extractApiErrorCode(body: unknown): string | null {
  if (body !== null && typeof body === "object") {
    const b = body as { error?: { code?: unknown } };
    if (typeof b.error?.code === "string" && b.error.code.length > 0) {
      return b.error.code;
    }
  }
  return null;
}
