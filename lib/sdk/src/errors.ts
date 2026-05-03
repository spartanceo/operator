/**
 * Single error type the SDK throws for non-2xx responses or transport
 * failures. Consumers can branch on `code` (the API's error code) or
 * `status` (HTTP status) without parsing strings.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
