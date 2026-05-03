import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Pause,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { ToolCall } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { RiskBadge } from "./risk-badge";
import { JsonView } from "./json-view";
import { cn } from "@/lib/utils";

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "running":
    case "pending":
      return <Loader2 className="h-4 w-4 animate-spin text-amber-500" />;
    case "awaiting_approval":
      return <Pause className="h-4 w-4 text-amber-500" />;
    case "denied":
    case "cancelled":
      return <XCircle className="h-4 w-4 text-muted-foreground" />;
    default:
      return <ChevronRight className="h-4 w-4 text-muted-foreground" />;
  }
}

function tryParseJson(value: string | undefined | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Task #100 — inline media renderer.
 *
 * When a media tool (`media.image.generate`, `media.audio.generate`,
 * `media.video.generate`, `media.image.upscale`, `media.image.removeBackground`)
 * returns a `MediaAsset` payload, surface the actual binary inline instead
 * of dumping the JSON. The asset shape is documented in `MediaAsset` in
 * `lib/api-spec/openapi.yaml` (kind ∈ image|audio|video, fileUrl is the
 * relative stream URL `/api/media/assets/{id}/file`).
 */
function pickMediaAsset(
  output: unknown,
): { kind: "image" | "audio" | "video"; fileUrl: string; mimeType?: string; prompt?: string } | null {
  if (!output || typeof output !== "object") return null;
  // The tool envelope often wraps the asset under `asset` or `data`; accept
  // the bare asset too so future tool authors don't have to thread it.
  const candidates: unknown[] = [
    output,
    (output as Record<string, unknown>).asset,
    (output as Record<string, unknown>).data,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const kind = o.kind;
    const fileUrl = o.fileUrl;
    if (
      (kind === "image" || kind === "audio" || kind === "video") &&
      typeof fileUrl === "string" &&
      fileUrl.length > 0
    ) {
      return {
        kind,
        fileUrl,
        mimeType: typeof o.mimeType === "string" ? o.mimeType : undefined,
        prompt: typeof o.prompt === "string" ? o.prompt : undefined,
      };
    }
  }
  return null;
}

function MediaPreview({ asset }: { asset: NonNullable<ReturnType<typeof pickMediaAsset>> }) {
  // Asset URLs are relative (e.g. `/api/media/assets/abc/file`). The website
  // runs behind the artifact base path, so prepend it.
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env
    ?.BASE_URL ?? "/";
  const src = asset.fileUrl.startsWith("/")
    ? `${base.replace(/\/$/, "")}${asset.fileUrl}`
    : asset.fileUrl;
  return (
    <div className="space-y-1" data-testid={`media-preview-${asset.kind}`}>
      {asset.prompt ? (
        <p className="text-xs italic text-muted-foreground">"{asset.prompt}"</p>
      ) : null}
      {asset.kind === "image" ? (
        <img
          src={src}
          alt={asset.prompt ?? "Generated image"}
          className="max-h-64 max-w-full rounded-md border border-border"
        />
      ) : null}
      {asset.kind === "audio" ? (
        <audio
          controls
          src={src}
          className="w-full"
          aria-label={asset.prompt ?? "Generated audio"}
        />
      ) : null}
      {asset.kind === "video" ? (
        <video
          controls
          src={src}
          className="max-h-64 max-w-full rounded-md border border-border"
          aria-label={asset.prompt ?? "Generated video"}
        />
      ) : null}
    </div>
  );
}

function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const input = tryParseJson(call.input);
  const output = tryParseJson(call.output);

  return (
    <li
      className="rounded-md border border-border bg-card"
      data-testid={`timeline-row-${call.id}`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover-elevate active-elevate-2"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <StatusIcon status={call.status} />
        <span className="font-mono text-sm text-foreground">{call.toolName}</span>
        <RiskBadge risk={call.riskLevel} />
        <Badge variant="outline" className="text-[10px] uppercase">
          {call.status}
        </Badge>
        {typeof call.durationMs === "number" ? (
          <span className="text-xs text-muted-foreground">
            {call.durationMs}ms
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(call.createdAt).toLocaleTimeString()}
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-3 pb-3 pt-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Input
            </p>
            <JsonView value={input} emptyLabel="No input recorded" />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Output
            </p>
            {(() => {
              const asset = pickMediaAsset(output);
              return asset ? <MediaPreview asset={asset} /> : (
                <JsonView value={output} emptyLabel="No output yet" />
              );
            })()}
          </div>
          {call.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {call.error}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ExecutionTimeline({
  calls,
  className,
}: {
  calls: ToolCall[];
  className?: string;
}) {
  if (calls.length === 0) {
    return (
      <p className={cn("text-xs italic text-muted-foreground", className)}>
        No tool calls yet.
      </p>
    );
  }
  return (
    <ul className={cn("space-y-2", className)} data-testid="timeline">
      {calls.map((call) => (
        <ToolCallRow key={call.id} call={call} />
      ))}
    </ul>
  );
}
