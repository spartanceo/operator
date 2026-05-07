/**
 * Image Generation Setup Card — shown during first-run / operator settings
 * when no image-gen backend is configured.
 *
 * Surfaces a one-click ComfyUI installer (via Docker) and cloud alternatives.
 * The card is self-dismissing — once the user selects a backend (detected
 * via the /api/capabilities/image-gen endpoint) it no longer renders.
 */
import { useEffect, useState } from "react";
import {
  ImageIcon,
  HardDrive,
  Globe,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToolInstallerCard } from "@/components/operator/tool-installer-card";
import { cn } from "@/lib/utils";

function getApiBase(): string {
  const win = window as Window &
    typeof globalThis & {
      electronAPI?: { getApiPort?: () => number | null };
    };
  const port = win.electronAPI?.getApiPort?.();
  return port ? `http://127.0.0.1:${port}/api` : "/api";
}

interface ImageGenSetupCardProps {
  onNavigateToSettings?: () => void;
}

const CLOUD_BACKENDS = [
  {
    id: "dalle",
    name: "DALL-E 3",
    residency: "cloud-required" as const,
    cost: "Paid",
    description: "OpenAI's image model. High quality, requires an OpenAI API key.",
    note: "~$0.04 per 1024×1024 image.",
  },
  {
    id: "stability-ai",
    name: "Stability AI",
    residency: "cloud-required" as const,
    cost: "Paid",
    description: "Stable Diffusion XL via Stability AI's cloud API.",
    note: "Requires a Stability AI API key.",
  },
];

export function ImageGenSetupCard({ onNavigateToSettings }: ImageGenSetupCardProps) {
  const [hasBackend, setHasBackend] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem("omninity:image-gen-card-dismissed") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch(`${getApiBase()}/capabilities/image-gen`);
        if (!res.ok || cancelled) return;
        const body = await res.json();
        const info = body?.data;
        if (!cancelled) {
          setHasBackend(Boolean(info?.activeBackendId));
        }
      } catch {
        if (!cancelled) setHasBackend(false);
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem("omninity:image-gen-card-dismissed", "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  if (dismissed || hasBackend === true) return null;
  if (hasBackend === null) return null;

  return (
    <Card
      className="relative border-dashed border-primary/30 bg-primary/5"
      data-testid="card-image-gen-setup"
    >
      <button
        type="button"
        onClick={dismiss}
        className="absolute right-3 top-3 rounded-sm text-muted-foreground hover:text-foreground"
        aria-label="Dismiss image generation setup card"
        data-testid="button-image-gen-dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <CardHeader className="pb-2 pr-8">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-primary/10 text-primary">
            <ImageIcon className="h-3.5 w-3.5" />
          </div>
          <CardTitle className="text-sm">Set up image generation</CardTitle>
        </div>
        <CardDescription className="text-xs">
          No image-generation backend is configured. Install ComfyUI locally
          (free) or connect a paid cloud service below.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Local option: ComfyUI with one-click installer */}
        <div className="rounded-md border border-border bg-background p-3 space-y-2">
          <div className="flex items-center gap-2">
            <HardDrive className="h-3.5 w-3.5 text-green-600" />
            <span className="text-xs font-medium text-foreground">ComfyUI</span>
            <Badge
              variant="outline"
              className="text-[9px] uppercase border-green-400 text-green-600"
            >
              Local
            </Badge>
            <Badge variant="outline" className="text-[9px] uppercase">
              Free
            </Badge>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Self-hosted Stable Diffusion. Your images never leave your machine.
          </p>
          <ToolInstallerCard
            toolId="comfyui"
            displayName="ComfyUI"
            description="Install ComfyUI locally (Python + git). It will run on localhost:8188 and connects automatically. Requires Python 3.10+."
            port={8188}
            manualCommand="git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git && cd ComfyUI && pip3 install -r requirements.txt && python3 main.py --listen 127.0.0.1 --port 8188"
            docsUrl="https://github.com/comfyanonymous/ComfyUI#installing"
            docsLabel="ComfyUI guide"
            onReady={() => {
              // Scroll to capability settings so user can activate backend
              const el = document.querySelector("[data-testid='tab-cap-image-gen']");
              if (el instanceof HTMLElement) el.click();
            }}
          />
        </div>

        {/* Cloud options */}
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Or use a cloud API
          </p>
          {CLOUD_BACKENDS.map((b) => (
            <div
              key={b.id}
              className="flex items-start gap-2.5 rounded-md border border-border bg-background p-2.5"
            >
              <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-600" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-foreground">{b.name}</span>
                  <Badge variant="outline" className="text-[9px] uppercase text-muted-foreground">
                    Cloud
                  </Badge>
                  <Badge variant="outline" className="text-[9px] uppercase">
                    {b.cost}
                  </Badge>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{b.description}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground/70">{b.note}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={onNavigateToSettings}
            data-testid="button-image-gen-configure"
          >
            Configure backend
          </Button>
          <button
            type="button"
            onClick={dismiss}
            className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            data-testid="button-image-gen-skip"
          >
            Skip for now
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
