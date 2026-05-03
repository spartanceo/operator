/**
 * Internal HTTP helper — handles tenant header, JSON parsing, the
 * `{success,data,error}` envelope and timeout enforcement. Lives
 * separately from `client.ts` so the resource modules can each consume
 * a tiny call surface.
 */
import { ApiError } from "./errors";
import type { ApiEnvelope, OmninityClientOptions } from "./types";

export interface InternalHttpOptions {
  baseUrl: string;
  tenantId: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export function resolveOptions(opts: OmninityClientOptions): InternalHttpOptions {
  if (!opts.tenantId) throw new Error("OmninityClient: tenantId is required");
  return {
    baseUrl: (opts.baseUrl ?? "http://localhost:3001").replace(/\/+$/, ""),
    tenantId: opts.tenantId,
    fetchImpl: opts.fetch ?? fetch,
    timeoutMs: opts.timeoutMs ?? 30_000,
  };
}

export async function request<T>(
  http: InternalHttpOptions,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(http.baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), http.timeoutMs);
  try {
    const res = await http.fetchImpl(url.toString(), {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-tenant-id": http.tenantId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const env = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!res.ok || !env || env.success !== true) {
      const code = env?.error?.code ?? "HTTP_ERROR";
      const msg = env?.error?.message ?? `HTTP ${res.status}`;
      throw new ApiError(res.status, code, msg);
    }
    return env.data as T;
  } finally {
    clearTimeout(timer);
  }
}
