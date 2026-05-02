/**
 * Typed error taxonomy — Step 1 of Task #31.
 *
 * Every failure in Omninity Operator should be one of these classes.
 * Each carries:
 *   - `code`         — stable machine-readable identifier (snake/SCREAM_CASE).
 *                      Surfaces in the API envelope, in logs, and as the key
 *                      into the user-message catalog.
 *   - `status`       — recommended HTTP status when surfaced via the API.
 *   - `expose`       — whether `message` is safe to send to the client. When
 *                      false, the API envelope replaces it with the catalog's
 *                      user-friendly message (or a generic fallback).
 *   - `details?`     — extra structured context for logs / clients.
 *   - `cause?`       — the original thrown value (preserved through layers).
 *
 * Construct domain-specific errors via the subclasses (e.g. `OllamaError`)
 * rather than stringly-typed `new DomainError(...)` calls — the subclasses
 * pin a canonical default code / status, which keeps the catalog complete.
 */

export type ErrorDomain =
  | "runtime"
  | "tool"
  | "storage"
  | "network"
  | "permission"
  | "integration"
  | "validation"
  | "auth"
  | "tenant"
  | "model"
  | "unknown";

export interface DomainErrorOptions {
  readonly code?: string;
  readonly status?: number;
  readonly expose?: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class DomainError extends Error {
  public readonly domain: ErrorDomain;
  public readonly code: string;
  public readonly status: number;
  public readonly expose: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(domain: ErrorDomain, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.domain = domain;
    this.code = options.code ?? defaultCodeForDomain(domain);
    this.status = options.status ?? defaultStatusForDomain(domain);
    this.expose = options.expose ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

function defaultCodeForDomain(d: ErrorDomain): string {
  switch (d) {
    case "runtime": return "RUNTIME_ERROR";
    case "tool": return "TOOL_FAILED";
    case "storage": return "STORAGE_ERROR";
    case "network": return "NETWORK_ERROR";
    case "permission": return "PERMISSION_DENIED";
    case "integration": return "INTEGRATION_FAILED";
    case "validation": return "INVALID_INPUT";
    case "auth": return "UNAUTHENTICATED";
    case "tenant": return "TENANT_ISOLATION";
    case "model": return "MODEL_ERROR";
    case "unknown": return "INTERNAL";
  }
}

function defaultStatusForDomain(d: ErrorDomain): number {
  switch (d) {
    case "validation": return 400;
    case "auth": return 401;
    case "permission": return 403;
    case "tenant": return 403;
    case "tool": return 422;
    case "integration": return 502;
    case "network": return 504;
    case "model": return 503;
    case "runtime":
    case "storage":
    case "unknown":
      return 500;
  }
}

/* ------------------------------------------------------------------ */
/* Domain subclasses — each pins a default code + status combination. */
/* ------------------------------------------------------------------ */

export class RuntimeError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super("runtime", message, options);
  }
}

export class ToolError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super("tool", message, options);
  }
}

export class StorageError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super("storage", message, options);
  }
}

export class NetworkError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super("network", message, options);
  }
}

export class PermissionError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super("permission", message, options);
  }
}

export class IntegrationError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super("integration", message, options);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super("validation", message, { expose: true, ...options });
  }
}

export class AuthError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super("auth", message, options);
  }
}

export class ModelError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super("model", message, options);
  }
}

/* ------------------------------------------------------------------ */
/* Specialised errors with pinned codes (catalog entries map to these) */
/* ------------------------------------------------------------------ */

export class TimeoutError extends NetworkError {
  constructor(operation: string, timeoutMs: number, options: DomainErrorOptions = {}) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`, {
      code: "TIMEOUT",
      status: 504,
      details: { operation, timeoutMs },
      ...options,
    });
  }
}

export class CircuitOpenError extends NetworkError {
  constructor(name: string, options: DomainErrorOptions = {}) {
    super(`Circuit breaker '${name}' is open`, {
      code: "CIRCUIT_OPEN",
      status: 503,
      details: { breaker: name },
      ...options,
    });
  }
}

export class OllamaUnavailableError extends ModelError {
  constructor(options: DomainErrorOptions = {}) {
    super("Ollama is not reachable", {
      code: "OLLAMA_UNAVAILABLE",
      status: 503,
      ...options,
    });
  }
}

export class ModelOutOfMemoryError extends ModelError {
  constructor(modelName: string, options: DomainErrorOptions = {}) {
    super(`Model '${modelName}' ran out of memory`, {
      code: "MODEL_OOM",
      status: 503,
      details: { modelName },
      ...options,
    });
  }
}

export class DiskSpaceLowError extends StorageError {
  constructor(freeBytes: number, options: DomainErrorOptions = {}) {
    super(`Disk space critically low (${formatBytes(freeBytes)} free)`, {
      code: "DISK_SPACE_LOW",
      status: 507,
      details: { freeBytes },
      ...options,
    });
  }
}

export class FileNotFoundError extends StorageError {
  constructor(path: string, options: DomainErrorOptions = {}) {
    super(`File not found: ${path}`, {
      code: "FILE_NOT_FOUND",
      status: 404,
      expose: true,
      details: { path },
      ...options,
    });
  }
}

export class RateLimitedError extends IntegrationError {
  constructor(service: string, retryAfterMs: number, options: DomainErrorOptions = {}) {
    super(`Service '${service}' is rate-limited`, {
      code: "RATE_LIMITED",
      status: 429,
      details: { service, retryAfterMs },
      ...options,
    });
  }
}

export class OAuthExpiredError extends AuthError {
  constructor(provider: string, options: DomainErrorOptions = {}) {
    super(`OAuth token for '${provider}' has expired`, {
      code: "OAUTH_EXPIRED",
      status: 401,
      details: { provider },
      ...options,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Type guards                                                         */
/* ------------------------------------------------------------------ */

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
