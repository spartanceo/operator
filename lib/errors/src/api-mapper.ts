/**
 * `toApiError` — converts any thrown value into the triple consumed by the
 * API envelope helper:
 *   { code, message, status, details? }
 *
 * Rules (Standard 1 + Standard 12):
 *   - DomainError instances surface `code` and `status` directly. The
 *     `message` is `error.message` only if `expose === true`; otherwise
 *     the catalog's user-facing message is used.
 *   - Express-style `{ status / statusCode / expose }` errors are honoured
 *     so existing third-party error throwers keep working.
 *   - Anything else collapses to `{ code: "INTERNAL", status: 500,
 *     message: getUserMessage("INTERNAL").message }`. Internal details NEVER
 *     leak to the client.
 *
 * The original error is always preserved on the `cause` property so the
 * caller (typically the api-server error middleware) can log it in full.
 */
import {
  DomainError,
  isDomainError,
} from "./error-taxonomy.js";
import { getUserMessage } from "./error-catalog.js";

export interface ApiErrorTriple {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly cause: unknown;
}

interface ExpressLikeError {
  code?: string;
  status?: number;
  statusCode?: number;
  expose?: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export function toApiError(error: unknown): ApiErrorTriple {
  if (isDomainError(error)) {
    return fromDomainError(error);
  }

  if (typeof error === "object" && error !== null) {
    const e = error as ExpressLikeError;
    const status = e.status ?? e.statusCode;
    if (typeof status === "number") {
      const code = e.code ?? defaultCodeForStatus(status);
      const message =
        e.expose && typeof e.message === "string"
          ? e.message
          : getUserMessage(code).message;
      const result: ApiErrorTriple = e.details
        ? { code, message, status, details: e.details, cause: error }
        : { code, message, status, cause: error };
      return result;
    }
  }

  return {
    code: "INTERNAL",
    message: getUserMessage("INTERNAL").message,
    status: 500,
    cause: error,
  };
}

function fromDomainError(error: DomainError): ApiErrorTriple {
  const message = error.expose ? error.message : getUserMessage(error.code).message;
  const triple: ApiErrorTriple = error.details
    ? {
        code: error.code,
        message,
        status: error.status,
        details: error.details,
        cause: error,
      }
    : {
        code: error.code,
        message,
        status: error.status,
        cause: error,
      };
  return triple;
}

function defaultCodeForStatus(status: number): string {
  if (status === 404) return "NOT_FOUND";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 400 || status === 422) return "INVALID_INPUT";
  if (status === 429) return "RATE_LIMITED";
  if (status === 504) return "TIMEOUT";
  if (status >= 500) return "INTERNAL";
  return "INTERNAL";
}
