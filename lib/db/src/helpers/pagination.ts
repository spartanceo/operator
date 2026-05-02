/**
 * Standard 13 — canonical pagination helpers.
 *
 * The cursor envelope `{ items, nextCursor }` is the only allowed shape for
 * list endpoint responses. The OpenAPI gate (Check #16) enforces the YAML
 * contract; these helpers enforce the same shape from the route-handler side
 * so the two never drift.
 *
 * Cursors are opaque to callers — base64url-encoded so they survive URL query
 * strings. The internal value is whatever the service uses to seek the next
 * page (commonly the last row's primary key).
 */
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type PaginatedData,
} from "@workspace/types";

/**
 * Wrap a page of results in the canonical envelope. Pass `null` for
 * `nextCursor` when there is no next page.
 */
export function paginated<T>(
  items: ReadonlyArray<T>,
  nextCursor: string | null,
): PaginatedData<T> {
  return { items, nextCursor };
}

/**
 * Build a `{ items, nextCursor }` envelope from an oversampled query.
 *
 * The standard fetch pattern is `LIMIT (limit + 1)` — if the extra row comes
 * back, we know there is a next page and use it to compute the cursor. This
 * helper centralises that arithmetic so individual services can't get it wrong.
 *
 * `getCursor` is called only on the last visible item — typically returns the
 * row's primary key.
 */
export function buildPage<T>(
  rows: ReadonlyArray<T>,
  limit: number,
  getCursor: (row: T) => string,
): PaginatedData<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && items.length > 0
      ? encodeCursor(getCursor(items[items.length - 1]!))
      : null;
  return { items, nextCursor };
}

/** Encode a service-internal cursor token to a URL-safe opaque string. */
export function encodeCursor(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Decode a client-supplied cursor token back to the internal seek value. */
export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

/**
 * Normalise the user-supplied `limit` against the project's bounds
 * (Section 6 of the project context). Defaults to 20, max 100.
 */
export function normaliseLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.floor(input), MAX_PAGE_LIMIT);
}

export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@workspace/types";
