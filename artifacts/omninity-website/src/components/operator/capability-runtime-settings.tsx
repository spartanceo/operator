/**
 * Capability Runtime Settings panel — extends the model runtime switcher to
 * cover all non-LLM AI capability types:
 *
 *   - Image generation   (ComfyUI, DALL-E, Stability AI)
 *   - Web search         (SearXNG, Brave Search, Serper)
 *   - Text-to-speech     (Piper TTS, ElevenLabs, OpenAI TTS)
 *   - Embeddings         (Ollama, Qdrant, OpenAI ada-002)
 *   - Code sandbox       (Local Docker, E2B, Modal)
 *
 * Each backend shows its residency (local / cloud-assist / cloud-required),
 * health status, and whether it needs a paid API key — mirroring the
 * privacy-meter pattern from the model runtime switcher.
 *
 * Switching a backend immediately POSTs to /api/capabilities/:type/active
 * and invalidates the query cache so dependent UI updates instantly.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle,
  Circle,
  CloudOff,
  Globe,
  HardDrive,
  Key,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
function getApiBase(): string {
  const win = window as Window &
    typeof globalThis & {
      electronAPI?: { getApiPort?: () => number | null };
    };
  const port = win.electronAPI?.getApiPort?.();
  return port ? `http://127.0.0.1:${port}/api` : "/api";
}

type CapabilityType =
  | "image-gen"
  | "web-search"
  | "tts"
  | "embeddings"
  | "code-sandbox";

type CapabilityResidency = "local" | "cloud-assist" | "cloud-required";
type CapabilityHealthStatus = "healthy" | "unreachable" | "needs-credentials" | "unknown";

interface CapabilityHealth {
  status: CapabilityHealthStatus;
  detail: string | null;
  detectedAt: string;
}

interface CapabilityDescriptor {
  id: string;
  displayName: string;
  capabilityType: CapabilityType;
  residency: CapabilityResidency;
  requiresApiKey: boolean;
  hasCredential: boolean;
  health: CapabilityHealth;
}

interface ActiveCapabilityInfo {
  capabilityType: CapabilityType;
  activeBackendId: string | null;
  detectedBackendIds: string[];
  backends: CapabilityDescriptor[];
}

const CAPABILITY_LABELS: Record<
  CapabilityType,
  { title: string; description: string }
> = {
  "image-gen": {
    title: "Image Generation",
    description:
      "Diffusion and image-synthesis backends. Local via ComfyUI, cloud via DALL-E or Stability AI.",
  },
  "web-search": {
    title: "Web Search",
    description:
      "Web-search backends. Self-hosted SearXNG keeps queries on-device; Brave Search and Serper route to the cloud.",
  },
  tts: {
    title: "Text-to-Speech",
    description:
      "Voice-synthesis backends. Piper runs fully local; ElevenLabs and OpenAI TTS are cloud-only.",
  },
  embeddings: {
    title: "Embeddings",
    description:
      "Vector-embedding backends used by the knowledge base. Ollama or Qdrant run locally; OpenAI ada-002 is cloud.",
  },
  "code-sandbox": {
    title: "Code Sandbox",
    description:
      "Sandboxed code-execution backends. Local Docker keeps code on-device; E2B and Modal run in the cloud.",
  },
};

const RESIDENCY_CONFIG: Record<
  CapabilityResidency,
  { label: string; icon: typeof HardDrive; className: string }
> = {
  local: { label: "Local", icon: HardDrive, className: "text-green-600" },
  "cloud-assist": {
    label: "Cloud (your key)",
    icon: Globe,
    className: "text-yellow-600",
  },
  "cloud-required": {
    label: "Cloud",
    icon: Globe,
    className: "text-orange-600",
  },
};

const HEALTH_CONFIG: Record<
  CapabilityHealthStatus,
  { icon: typeof CheckCircle; className: string; label: string }
> = {
  healthy: {
    icon: CheckCircle,
    className: "text-green-500",
    label: "Reachable",
  },
  unreachable: {
    icon: XCircle,
    className: "text-red-500",
    label: "Unreachable",
  },
  "needs-credentials": {
    icon: Key,
    className: "text-yellow-500",
    label: "Needs API key",
  },
  unknown: { icon: Circle, className: "text-muted-foreground", label: "Not yet implemented" },
};

async function fetchCapabilityInfo(): Promise<ActiveCapabilityInfo[]> {
  const res = await fetch(`${getApiBase()}/capabilities`);
  if (!res.ok) throw new Error(`Failed to load capabilities: ${res.status}`);
  const body = await res.json();
  return (body.data?.items ?? []) as ActiveCapabilityInfo[];
}

async function postSetActive(
  capabilityType: CapabilityType,
  backendId: string | null,
): Promise<void> {
  const res = await fetch(`${getApiBase()}/capabilities/${capabilityType}/active`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backendId }),
  });
  if (!res.ok) throw new Error(`Failed to set backend: ${res.status}`);
}

function ResidencyBadge({ residency }: { residency: CapabilityResidency }) {
  const cfg = RESIDENCY_CONFIG[residency];
  const Icon = cfg.icon;
  return (
    <span className={cn("flex items-center gap-1 text-[10px] font-medium uppercase", cfg.className)}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

function HealthDot({ status }: { status: CapabilityHealthStatus }) {
  const cfg = HEALTH_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <span
      title={cfg.label}
      className={cn("flex items-center gap-1 text-[10px]", cfg.className)}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

function BackendRow({
  backend,
  active,
  detected,
  onSelect,
  busy,
}: {
  backend: CapabilityDescriptor;
  active: boolean;
  detected: boolean;
  onSelect: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={busy}
      className={cn(
        "w-full rounded-md border p-2.5 text-left transition-colors",
        active
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/30",
      )}
      data-testid={`button-cap-select-${backend.id}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium text-foreground">
          {backend.displayName}
        </span>
        {active ? (
          <Badge variant="secondary" className="text-[9px] uppercase">
            Active
          </Badge>
        ) : null}
        {detected && !active ? (
          <Badge variant="outline" className="text-[9px] uppercase text-green-600 border-green-400">
            Detected
          </Badge>
        ) : null}
        {backend.requiresApiKey ? (
          <Badge variant="outline" className="text-[9px] uppercase">
            Paid
          </Badge>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <ResidencyBadge residency={backend.residency} />
        <HealthDot status={backend.health.status} />
        {backend.health.detail ? (
          <span className="text-[10px] text-muted-foreground">
            {backend.health.detail}
          </span>
        ) : null}
      </div>
    </button>
  );
}

function CapabilityPanel({
  info,
  onSwitch,
  busy,
}: {
  info: ActiveCapabilityInfo;
  onSwitch: (backendId: string | null) => void;
  busy: boolean;
}) {
  const label = CAPABILITY_LABELS[info.capabilityType];
  const detectedSet = new Set(info.detectedBackendIds);

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{label.description}</p>
      {info.backends.length === 0 ? (
        <p className="rounded-md border border-border bg-muted/20 p-2.5 text-xs text-muted-foreground">
          No backends registered for this capability type.
        </p>
      ) : (
        <div className="space-y-1.5">
          {info.backends.map((b) => (
            <BackendRow
              key={b.id}
              backend={b}
              active={b.id === info.activeBackendId}
              detected={detectedSet.has(b.id)}
              onSelect={() => onSwitch(b.id)}
              busy={busy}
            />
          ))}
        </div>
      )}
      {info.activeBackendId ? (
        <button
          type="button"
          onClick={() => onSwitch(null)}
          disabled={busy}
          className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          data-testid={`button-cap-clear-${info.capabilityType}`}
        >
          Clear selection
        </button>
      ) : null}
    </div>
  );
}

const CAPABILITY_ORDER: CapabilityType[] = [
  "image-gen",
  "web-search",
  "tts",
  "embeddings",
  "code-sandbox",
];

export function CapabilityRuntimeSettings() {
  const qc = useQueryClient();
  const [allInfo, setAllInfo] = useState<ActiveCapabilityInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<CapabilityType | null>(null);
  const [activeTab, setActiveTab] = useState<CapabilityType>("image-gen");

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchCapabilityInfo();
      setAllInfo(data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const handleSwitch = async (
    capabilityType: CapabilityType,
    backendId: string | null,
  ) => {
    setSwitching(capabilityType);
    try {
      await postSetActive(capabilityType, backendId);
      setAllInfo((prev) =>
        prev
          ? prev.map((i) =>
              i.capabilityType === capabilityType
                ? { ...i, activeBackendId: backendId }
                : i,
            )
          : prev,
      );
      void qc.invalidateQueries();
    } catch {
      /* silently reflected in health on next load */
    } finally {
      setSwitching(null);
    }
  };

  if (allInfo === null && !loading && !loadError) {
    void load();
  }

  const ordered =
    allInfo == null
      ? []
      : CAPABILITY_ORDER.map(
          (t) => allInfo.find((i) => i.capabilityType === t)!,
        ).filter(Boolean);

  const activeInfo = ordered.find((i) => i.capabilityType === activeTab) ?? null;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Capability Backends</CardTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={load}
            disabled={loading}
            data-testid="button-cap-refresh"
            aria-label="Refresh capability backends"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
        <CardDescription className="text-xs">
          Select the backend for each AI capability. Local backends keep data on
          your device. Cloud backends require an API key and may incur costs.
          Each capability type is switched independently.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <CloudOff className="h-3.5 w-3.5 shrink-0" />
            {loadError}
          </div>
        ) : null}

        {loading && allInfo === null ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading capability backends…
          </p>
        ) : null}

        {ordered.length > 0 ? (
          <>
            <div
              className="flex gap-1 border-b border-border pb-0.5"
              role="tablist"
              aria-label="Capability types"
            >
              {ordered.map((info) => {
                const label = CAPABILITY_LABELS[info.capabilityType];
                const isActive = activeTab === info.capabilityType;
                return (
                  <button
                    key={info.capabilityType}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveTab(info.capabilityType)}
                    className={cn(
                      "rounded-t-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                      isActive
                        ? "bg-background border border-b-background border-border text-foreground -mb-px"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    data-testid={`tab-cap-${info.capabilityType}`}
                  >
                    {label.title}
                    {info.activeBackendId ? (
                      <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                    ) : (
                      <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                    )}
                  </button>
                );
              })}
            </div>

            {activeInfo ? (
              <CapabilityPanel
                info={activeInfo}
                onSwitch={(backendId) =>
                  handleSwitch(activeInfo.capabilityType, backendId)
                }
                busy={switching === activeInfo.capabilityType}
              />
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
