import {
  setBaseUrl,
  setDefaultHeaders,
  setDefaultCredentials,
} from "@workspace/api-client-react";

const TENANT_STORAGE_KEY = "omninity.operator.tenantId";
const WORKSPACE_STORAGE_KEY = "omninity.operator.workspaceId";

const DEFAULT_TENANT_ID = "operator-local";
const DEFAULT_WORKSPACE_ID = `default-${DEFAULT_TENANT_ID}`;

function safeRead(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value && value.length > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage disabled */
  }
}

export function getTenantId(): string {
  return safeRead(TENANT_STORAGE_KEY, DEFAULT_TENANT_ID);
}

export function getWorkspaceId(): string {
  return safeRead(WORKSPACE_STORAGE_KEY, DEFAULT_WORKSPACE_ID);
}

export function setTenantId(id: string): void {
  safeWrite(TENANT_STORAGE_KEY, id);
  reapplyHeaders();
}

export function setWorkspaceId(id: string): void {
  safeWrite(WORKSPACE_STORAGE_KEY, id);
  reapplyHeaders();
}

function reapplyHeaders(): void {
  setDefaultHeaders({
    "X-Tenant-ID": getTenantId(),
    "X-Workspace-ID": getWorkspaceId(),
  });
}

let initialized = false;

/**
 * Initialise the API client with tenant headers and — when running inside
 * the Electron desktop shell — redirect all API calls to the embedded
 * Express server's localhost port.
 *
 * The `electronAPI` surface is injected by the Electron preload script
 * (`artifacts/omninity-desktop/src/preload.ts`) via `contextBridge`. In the
 * standard web build the property is absent and the client uses the
 * Vite-proxied relative-URL path (no change from previous behaviour).
 */
export function initApiClient(): void {
  if (initialized) return;
  initialized = true;

  const win = window as Window &
    typeof globalThis & {
      electronAPI?: {
        getApiPort?: () => number | null;
      };
    };

  const electronPort = win.electronAPI?.getApiPort?.();
  if (electronPort) {
    setBaseUrl(`http://127.0.0.1:${electronPort}`);
  }

  setDefaultCredentials("include");
  reapplyHeaders();
}
