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
 * For the TTS capability type an additional voice-selection dropdown appears
 * beneath the backend list so users can pick a voice without leaving the panel.
 * Piper voices include a link to the official Piper releases page for
 * downloading additional voice models.
 *
 * Switching a backend immediately POSTs to /api/capabilities/:type/active
 * and invalidates the query cache so dependent UI updates instantly.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle,
  Circle,
  CloudOff,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  Key,
  Loader2,
  RefreshCw,
  Trash2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useListVoices } from "@workspace/api-client-react";
import { useSettings } from "@/contexts/settings-context";

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
      "Voice-synthesis backends. Piper runs fully local; ElevenLabs and OpenAI TTS are cloud-only and require an API key.",
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

const PIPER_RELEASES_URL =
  "https://github.com/rhasspy/piper/releases";

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

const SETUP_GUIDE_URLS: Partial<Record<string, string>> = {
  comfyui: "https://github.com/comfyanonymous/ComfyUI#installing",
};

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
  const showGuideLink =
    backend.health.status === "unreachable" &&
    SETUP_GUIDE_URLS[backend.id] !== undefined;

  return (
    <div className="space-y-1">
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

      {showGuideLink ? (
        <a
          href={SETUP_GUIDE_URLS[backend.id]}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 pl-1 text-[10px] text-primary underline underline-offset-2 hover:text-primary/80"
          data-testid={`link-cap-setup-guide-${backend.id}`}
        >
          <ExternalLink className="h-2.5 w-2.5" />
          Setup guide — install {backend.displayName}
        </a>
      ) : null}
    </div>
  );
}

interface PiperModelEntry {
  id: string;
  label: string;
  language: string;
  gender: string;
  sampleRate: number;
  installed: boolean;
  modelsDir: string;
  releasesUrl: string;
}

/**
 * Piper voice model manager — shows install status for each bundled voice
 * and lets users download model files (.onnx + .onnx.json) from HuggingFace.
 * Displayed only when the active TTS backend is Piper.
 */
function PiperModelManager() {
  const qc = useQueryClient();
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  const modelsQuery = useQuery<{ items: PiperModelEntry[]; releasesUrl: string }>({
    queryKey: ["piper-models"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/voice/piper/models`);
      if (!res.ok) throw new Error(`Failed to load Piper models: ${res.status}`);
      const body = await res.json();
      return body.data as { items: PiperModelEntry[]; releasesUrl: string };
    },
    staleTime: 30_000,
  });

  const models = modelsQuery.data?.items ?? [];
  const releasesUrl = modelsQuery.data?.releasesUrl ?? PIPER_RELEASES_URL;
  const modelsDir = models[0]?.modelsDir ?? "~/.omninity/piper-voices";

  const installModel = async (voiceId: string) => {
    setInstalling((s) => new Set(s).add(voiceId));
    setActionErrors((e) => { const n = { ...e }; delete n[voiceId]; return n; });
    try {
      const res = await fetch(`${getApiBase()}/voice/piper/models/${voiceId}/install`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      await qc.invalidateQueries({ queryKey: ["piper-models"] });
      await modelsQuery.refetch();
    } catch (e) {
      setActionErrors((prev) => ({
        ...prev,
        [voiceId]: e instanceof Error ? e.message : "Download failed",
      }));
    } finally {
      setInstalling((s) => { const n = new Set(s); n.delete(voiceId); return n; });
    }
  };

  const removeModel = async (voiceId: string) => {
    setRemoving((s) => new Set(s).add(voiceId));
    try {
      await fetch(`${getApiBase()}/voice/piper/models/${voiceId}`, { method: "DELETE" });
      await modelsQuery.refetch();
    } finally {
      setRemoving((s) => { const n = new Set(s); n.delete(voiceId); return n; });
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">Voice models</p>
        {modelsQuery.isLoading ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : (
          <button
            type="button"
            onClick={() => void modelsQuery.refetch()}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Refresh model list"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        )}
      </div>

      {modelsQuery.isError ? (
        <p className="text-[10px] text-red-500">
          Could not load model status — is the API server running?
        </p>
      ) : models.length === 0 && !modelsQuery.isLoading ? (
        <p className="text-[10px] text-muted-foreground italic">No models found.</p>
      ) : (
        <ul className="divide-y divide-border">
          {models.map((m) => {
            const isInstalling = installing.has(m.id);
            const isRemoving = removing.has(m.id);
            const errMsg = actionErrors[m.id];
            return (
              <li key={m.id} className="flex items-center gap-2 py-1.5 text-[11px]">
                {m.installed ? (
                  <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />
                ) : (
                  <Circle className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                )}
                <span className="flex-1 min-w-0">
                  <span className="font-medium text-foreground truncate block">{m.label}</span>
                  {errMsg ? (
                    <span className="text-red-500 text-[10px]">{errMsg}</span>
                  ) : (
                    <span className="text-muted-foreground text-[10px]">
                      {m.language} · {m.sampleRate.toLocaleString()} Hz
                      {m.installed ? " · Installed" : " · Not downloaded"}
                    </span>
                  )}
                </span>
                {m.installed ? (
                  <button
                    type="button"
                    onClick={() => void removeModel(m.id)}
                    disabled={isRemoving}
                    className="shrink-0 text-muted-foreground hover:text-red-500 disabled:opacity-40"
                    aria-label={`Remove ${m.label}`}
                    title="Remove model files"
                  >
                    {isRemoving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void installModel(m.id)}
                    disabled={isInstalling}
                    className="shrink-0 flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted/50 disabled:opacity-40"
                    aria-label={`Install ${m.label}`}
                    data-testid={`button-piper-install-${m.id}`}
                  >
                    {isInstalling ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Download className="h-3 w-3" />
                    )}
                    {isInstalling ? "Downloading…" : "Install"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-[10px] text-muted-foreground">
        Models stored in{" "}
        <code className="font-mono text-[9px]">{modelsDir}</code>
        {" · "}
        <a
          href={releasesUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
        >
          More voices
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </p>
    </div>
  );
}

/**
 * Voice selection sub-panel — shown only in the TTS tab.
 * Fetches the voice catalogue for the currently active backend and lets the
 * user pick a default voice. Changes are saved to operator settings.
 * For Piper, also shows the model manager with install/remove controls.
 */
function TTSVoiceSelector({ activeBackendId }: { activeBackendId: string | null }) {
  const { settings, update } = useSettings();
  const voicesQuery = useListVoices();
  const voices = voicesQuery.data?.data.items ?? [];
  const isPiper = activeBackendId === "piper-tts";

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
        <p className="text-xs font-medium text-foreground">Voice selection</p>
        {voicesQuery.isLoading ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading voices…
          </p>
        ) : voices.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            {activeBackendId
              ? "No voices available — check that the backend is reachable."
              : "Select a TTS backend above to see available voices."}
          </p>
        ) : (
          <Select
            value={settings.voiceName}
            onValueChange={(v) => update({ voiceName: v })}
          >
            <SelectTrigger
              className="h-8 text-xs"
              aria-label="Default voice"
              data-testid="select-cap-voice"
            >
              <SelectValue placeholder="Pick a voice" />
            </SelectTrigger>
            <SelectContent>
              {voices.map((v: { id: string; label: string; language: string; gender: string }) => (
                <SelectItem key={v.id} value={v.id} className="text-xs">
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {isPiper ? <PiperModelManager /> : null}
    </div>
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
      {info.capabilityType === "tts" ? (
        <TTSVoiceSelector activeBackendId={info.activeBackendId} />
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
      void qc.invalidateQueries();
      // Re-probe all capability health after switching so the UI reflects the
      // newly selected backend's live connection state immediately.
      await load();
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
