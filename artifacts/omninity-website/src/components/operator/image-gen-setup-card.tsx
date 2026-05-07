/**
 * Image Generation Setup Card — shown during first-run / operator settings
 * when no image-gen backend is configured.
 *
 * Surfaces a clear explanation of the ComfyUI local option plus the paid
 * cloud alternatives, with a "Go to settings" link to the capability
 * switcher and a "Skip for now" dismiss.
 *
 * The card is self-dismissing — once the user selects a backend (detected
 * via the /api/capabilities/image-gen endpoint) it no longer renders.
 */
import { useEffect, useState } from "react";
import {
  ImageIcon,
  HardDrive,
  Globe,
  ExternalLink,
  X,
  ChevronDown,
  ChevronRight,
  CheckCircle,
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

const COMFYUI_GUIDE_URL =
  "https://github.com/comfyanonymous/ComfyUI#installing";

const RECOMMENDED_CHECKPOINT = "v1-5-pruned-emaonly.safetensors";
const RECOMMENDED_CHECKPOINT_URL =
  "https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors";

const BACKENDS = [
  {
    id: "comfyui",
    name: "ComfyUI",
    residency: "local" as const,
    cost: "Free",
    description: "Self-hosted Stable Diffusion. Your images never leave your machine.",
    note: "Requires a separate ComfyUI install.",
  },
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
  const [guideOpen, setGuideOpen] = useState(false);

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
          No image-generation backend is configured. Agents can generate images
          once you connect a backend — locally via ComfyUI or via a paid cloud
          service.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="space-y-2">
          {BACKENDS.map((b) => (
            <div
              key={b.id}
              className="flex items-start gap-2.5 rounded-md border border-border bg-background p-2.5"
            >
              <div className="mt-0.5 shrink-0">
                {b.residency === "local" ? (
                  <HardDrive className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Globe className="h-3.5 w-3.5 text-orange-600" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-foreground">{b.name}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[9px] uppercase",
                      b.residency === "local"
                        ? "border-green-400 text-green-600"
                        : "text-muted-foreground",
                    )}
                  >
                    {b.residency === "local" ? "Local" : "Cloud"}
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

        <div>
          <button
            type="button"
            onClick={() => setGuideOpen((p) => !p)}
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
            data-testid="button-comfyui-guide-toggle"
          >
            {guideOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            How to set up ComfyUI (free, local)
          </button>

          {guideOpen ? (
            <div className="mt-2 space-y-1.5 rounded-md border border-border bg-background p-3 text-[11px] text-muted-foreground">
              <div className="flex items-start gap-1.5">
                <CheckCircle className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
                <span>
                  Install ComfyUI from GitHub:{" "}
                  <a
                    href={COMFYUI_GUIDE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    comfyanonymous/ComfyUI
                    <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" />
                  </a>
                </span>
              </div>
              <div className="flex items-start gap-1.5">
                <CheckCircle className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
                <span>
                  Download the recommended checkpoint{" "}
                  <a
                    href={RECOMMENDED_CHECKPOINT_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    {RECOMMENDED_CHECKPOINT}
                    <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" />
                  </a>{" "}
                  and place it in <code className="rounded bg-muted px-1">ComfyUI/models/checkpoints/</code>
                </span>
              </div>
              <div className="flex items-start gap-1.5">
                <CheckCircle className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
                <span>
                  Start ComfyUI. It listens on{" "}
                  <code className="rounded bg-muted px-1">http://localhost:8188</code> by default.
                </span>
              </div>
              <div className="flex items-start gap-1.5">
                <CheckCircle className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
                <span>
                  Return here and select <strong>ComfyUI (local)</strong> in the
                  Capability Backends panel below.
                </span>
              </div>
            </div>
          ) : null}
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
