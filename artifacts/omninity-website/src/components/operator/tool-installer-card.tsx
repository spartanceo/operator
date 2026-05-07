/**
 * ToolInstallerCard — reusable one-click installer card for local tools
 * (SearXNG via Docker, ComfyUI via portable release).
 *
 * Status flow: idle → checking → downloading → running → ready (or failed).
 * Polls /api/tools/install/:tool/status on mount and during active installs.
 *
 * Manual instructions are shown only when Docker is unavailable (for
 * Docker-based tools) or when an install has failed — keeping the default
 * view clean for non-technical users.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { getTenantId, getWorkspaceId } from "@/lib/api-config";

function getApiBase(): string {
  const win = window as Window &
    typeof globalThis & {
      electronAPI?: { getApiPort?: () => number | null };
    };
  const port = win.electronAPI?.getApiPort?.();
  return port ? `http://127.0.0.1:${port}/api` : "/api";
}

function tenantHeaders(): Record<string, string> {
  try {
    return {
      "X-Tenant-ID": getTenantId(),
      "X-Workspace-ID": getWorkspaceId(),
    };
  } catch {
    return {};
  }
}

export type InstallPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "running"
  | "ready"
  | "failed";

interface ToolInstallState {
  toolId: string;
  phase: InstallPhase;
  message: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
}

const PHASE_PROGRESS: Record<InstallPhase, number> = {
  idle: 0,
  checking: 10,
  downloading: 40,
  running: 75,
  ready: 100,
  failed: 0,
};

const PHASE_LABEL: Record<InstallPhase, string> = {
  idle: "Not started",
  checking: "Checking…",
  downloading: "Downloading…",
  running: "Starting…",
  ready: "Ready",
  failed: "Failed",
};

export interface ToolInstallerCardProps {
  toolId: string;
  displayName: string;
  description: string;
  port: number;
  manualCommand: string;
  docsUrl: string;
  docsLabel: string;
  /** Set to true for tools that install via Docker (e.g. SearXNG). When false,
   *  Docker availability is not checked and no Docker-missing banner is shown. */
  requiresDocker?: boolean;
  onReady?: () => void;
  className?: string;
}

export function ToolInstallerCard({
  toolId,
  displayName,
  description,
  port,
  manualCommand,
  docsUrl,
  docsLabel,
  requiresDocker = false,
  onReady,
  className,
}: ToolInstallerCardProps) {
  const [state, setState] = useState<ToolInstallState | null>(null);
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const calledReadyRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollingRef.current !== null) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async (): Promise<ToolInstallState | null> => {
    try {
      const res = await fetch(`${getApiBase()}/tools/install/${toolId}/status`, {
        headers: tenantHeaders(),
      });
      if (!res.ok) return null;
      const body = await res.json();
      return (body.data ?? null) as ToolInstallState | null;
    } catch {
      return null;
    }
  }, [toolId]);

  const fetchDockerStatus = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/tools/docker-status`);
      if (!res.ok) { setDockerAvailable(false); return; }
      const body = await res.json();
      setDockerAvailable(Boolean(body.data?.available));
    } catch {
      setDockerAvailable(false);
    }
  }, []);

  useEffect(() => {
    if (requiresDocker) void fetchDockerStatus();
    void fetchStatus().then((s) => { if (s) setState(s); });
  }, [fetchStatus, fetchDockerStatus, requiresDocker]);

  useEffect(() => {
    if (!state) return;
    const isTerminal = state.phase === "ready" || state.phase === "failed";
    if (isTerminal) stopPolling();
    if (state.phase === "ready" && !calledReadyRef.current) {
      calledReadyRef.current = true;
      onReady?.();
    }
  }, [state, stopPolling, onReady]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      const s = await fetchStatus();
      if (s) setState(s);
    }, 1500);
  }, [fetchStatus, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const handleInstall = async () => {
    try {
      const res = await fetch(`${getApiBase()}/tools/install/${toolId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tenantHeaders() },
      });
      if (!res.ok) return;
      const body = await res.json();
      setState(body.data as ToolInstallState);
      startPolling();
    } catch {
      /* network error */
    }
  };

  const handleRetry = async () => {
    calledReadyRef.current = false;
    try {
      await fetch(`${getApiBase()}/tools/install/${toolId}/reset`, {
        method: "POST",
        headers: tenantHeaders(),
      });
    } catch {
      /* ignore */
    }
    await handleInstall();
  };

  const phase = state?.phase ?? "idle";
  const isInProgress =
    phase === "checking" || phase === "downloading" || phase === "running";
  const progress = PHASE_PROGRESS[phase];
  // Docker-required banner only shown when Docker is not available AND the
  // tool actually needs Docker (checked by errorCode on a failed state or
  // by probing docker-status before the first install).
  // Docker is only relevant for Docker-based installers (e.g. SearXNG).
  // For portable installers (e.g. ComfyUI via Python/git) we never show a
  // Docker-missing banner regardless of the host Docker state.
  const dockerMissing = requiresDocker && dockerAvailable === false;
  // Manual instructions are only shown when Docker is unavailable (for
  // Docker-dependent tools) or the install has failed.
  const showManualExpander = dockerMissing || phase === "failed";

  return (
    <div className={cn("space-y-3", className)}>
      {/* Docker required banner — only shown pre-install when Docker is missing */}
      {dockerMissing && phase !== "ready" && !isInProgress ? (
        <div className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-900 dark:bg-amber-950">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-[11px] text-amber-800 dark:text-amber-200">
            Docker is required for automatic SearXNG install.{" "}
            <a
              href="https://docker.com/get-started"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
            >
              Download Docker
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </p>
        </div>
      ) : null}

      {/* Already connected */}
      {phase === "ready" ? (
        <div className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {displayName} — connected
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {state?.message ?? `Running on localhost:${port}.`}
            </p>
          </div>
        </div>
      ) : null}

      {/* Idle: show Install button (suppressed when Docker is required but missing) */}
      {phase === "idle" && !dockerMissing ? (
        <div className="rounded-md border border-border bg-card p-3 space-y-2">
          <p className="text-xs text-muted-foreground">{description}</p>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => void handleInstall()}
            data-testid={`button-install-${toolId}`}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Install Automatically
          </Button>
        </div>
      ) : null}

      {/* In-progress */}
      {isInProgress ? (
        <div className="rounded-md border border-border bg-card p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <p className="text-xs font-medium text-foreground">
              {PHASE_LABEL[phase]} — {displayName}
            </p>
          </div>
          <Progress value={progress} className="h-1.5" />
          <p className="text-[10px] text-muted-foreground">
            {state?.message ?? "…"}
          </p>
        </div>
      ) : null}

      {/* Failed */}
      {phase === "failed" ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <div className="flex-1 space-y-1">
              <p className="text-xs font-medium text-foreground">
                Install failed — {displayName}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {state?.message ?? "An unknown error occurred."}
              </p>
              {state?.errorCode === "DOCKER_REQUIRED" ? (
                <a
                  href="https://docker.com/get-started"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-[11px] text-primary underline underline-offset-2"
                >
                  Download Docker
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              ) : null}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[11px]"
            onClick={() => void handleRetry()}
            data-testid={`button-retry-${toolId}`}
          >
            <RefreshCw className="mr-1.5 h-3 w-3" />
            Retry
          </Button>
        </div>
      ) : null}

      {/* Manual instructions — only shown when Docker is unavailable or install failed */}
      {showManualExpander ? (
        <div>
          <button
            type="button"
            onClick={() => setManualOpen((p) => !p)}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            data-testid={`button-manual-toggle-${toolId}`}
          >
            {manualOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Show manual instructions
          </button>

          {manualOpen ? (
            <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/20 p-2.5">
              <div className="flex items-center gap-1.5">
                <Terminal className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="text-[10px] font-medium text-foreground">
                  Manual setup
                </span>
                <a
                  href={docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto flex items-center gap-0.5 text-[10px] text-primary underline underline-offset-2"
                >
                  <ExternalLink className="h-2.5 w-2.5" />
                  {docsLabel}
                </a>
              </div>
              <code className="block rounded bg-muted px-2 py-1.5 font-mono text-[10px] text-foreground break-all">
                {manualCommand}
              </code>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
