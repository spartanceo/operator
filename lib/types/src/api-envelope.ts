/**
 * Canonical API envelope shapes (Standard 1 + Standard 13).
 *
 * Every 2xx response in `lib/api-spec/openapi.yaml` MUST conform to one of
 * these shapes. The OpenAPI YAML is the contract; these TypeScript types
 * mirror it for code-side use (route handlers, service callers, tests).
 *
 * `success: true` → `data` is non-null, `error` is absent.
 * `success: false` → `data` is null/absent, `error` is populated.
 *
 * Pagination uses the cursor envelope (Standard 13 §"Pagination Envelope
 * Pattern"): callers `useInfiniteQuery` with `getNextPageParam: (last) =>
 * last.data.nextCursor`.
 */

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface ApiOk<T> {
  readonly success: true;
  readonly data: T;
}

export interface ApiFail {
  readonly success: false;
  readonly error: ApiError;
}

export type ApiEnvelope<T> = ApiOk<T> | ApiFail;

export interface PaginatedData<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | null;
}

export type PaginatedEnvelope<T> = ApiOk<PaginatedData<T>>;

/**
 * Standard pagination query parameters (Section 6 of the project context).
 * Defaults: limit=20, max limit=100. Cursor is opaque base64url.
 */
export interface PaginationQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
