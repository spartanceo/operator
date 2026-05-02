/**
 * Server-side helpers that mirror the OpenAPI envelope contract.
 *
 * The OpenAPI YAML (`lib/api-spec/openapi.yaml`) is the source of truth;
 * these helpers exist so route handlers can never accidentally produce a
 * payload that doesn't match. Every handler returns its data through
 * `ok()` / `err()` / `pageOk()` — never builds the envelope by hand.
 */
import type {
  ApiEnvelope,
  ApiError,
  PaginatedData,
  PaginatedEnvelope,
} from "@workspace/types";
import { paginated } from "@workspace/db";

export function ok<T>(data: T): ApiEnvelope<T> {
  return { success: true, data };
}

export function err(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiEnvelope<never> {
  const error: ApiError = details ? { code, message, details } : { code, message };
  return { success: false, error };
}

export function pageOk<T>(
  items: ReadonlyArray<T>,
  nextCursor: string | null,
): PaginatedEnvelope<T> {
  return { success: true, data: paginated(items, nextCursor) as PaginatedData<T> };
}
