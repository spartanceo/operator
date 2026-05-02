/**
 * Helpers for inspecting errors thrown by the generated React Query hooks
 * (`@workspace/api-client-react`). The Orval client uses a fetcher that
 * throws an Error with `.status` and `.body` set; the API envelope shape
 * for failures is `{ success: false, error: { code, message } }`.
 *
 * We avoid importing axios/fetcher types here so the helper stays decoupled
 * from the specific transport — call sites only need a `code` and `status`
 * pair to branch on, which is the contract every Omninity backend route
 * upholds via the shared error envelope (Standard 1).
 */

interface MaybeApiError {
  status?: number;
  body?: { error?: { code?: string } };
  response?: {
    status?: number;
    data?: { error?: { code?: string } };
  };
}

function readErrorEnvelope(err: unknown): {
  status: number | null;
  code: string | null;
} {
  if (!err || typeof err !== "object") return { status: null, code: null };
  const e = err as MaybeApiError;
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.response?.status === "number"
        ? e.response.status
        : null;
  const code =
    typeof e.body?.error?.code === "string"
      ? e.body.error.code
      : typeof e.response?.data?.error?.code === "string"
        ? e.response.data.error.code
        : null;
  return { status, code };
}

/**
 * Returns true when the error came back as `404 FEATURE_DISABLED`, which is
 * the contract the api-server uses to signal that a feature flag is off
 * (see `requireHardwareAwareFlag`). Callers use this to render a graceful
 * fallback to the legacy code path rather than an error banner.
 */
export function isFeatureDisabledError(err: unknown): boolean {
  const { status, code } = readErrorEnvelope(err);
  return status === 404 && code === "FEATURE_DISABLED";
}
