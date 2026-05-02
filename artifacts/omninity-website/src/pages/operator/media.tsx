import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Image as ImageIcon,
  Music,
  Video,
  Sparkles,
  Trash2,
  Download,
  Wand2,
  Eraser,
  Cpu,
} from "lucide-react";

import { OperatorLayout } from "@/components/operator/layout";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

import {
  useListMediaAssets,
  useGenerateImage,
  useGenerateAudio,
  useGenerateVideo,
  useUpscaleImage,
  useRemoveImageBackground,
  useDeleteMediaAsset,
  useGetMediaHardwareCapabilities,
  type MediaAsset,
  type MediaAssetKind,
  GenerateImageRequestStyle,
  GenerateAudioRequestKind,
} from "@workspace/api-client-react";

type LibraryFilter = "all" | MediaAssetKind;

const IMAGE_STYLES: Array<{ value: GenerateImageRequestStyle; label: string }> = [
  { value: GenerateImageRequestStyle.illustration, label: "Illustration" },
  { value: GenerateImageRequestStyle.photorealistic, label: "Photorealistic" },
  { value: GenerateImageRequestStyle.watercolor, label: "Watercolor" },
  { value: GenerateImageRequestStyle.pixel, label: "Pixel art" },
  { value: GenerateImageRequestStyle.neon, label: "Neon" },
  { value: GenerateImageRequestStyle.sketch, label: "Sketch" },
];

const AUDIO_KINDS: Array<{ value: GenerateAudioRequestKind; label: string }> = [
  { value: GenerateAudioRequestKind.music, label: "Music" },
  { value: GenerateAudioRequestKind.tts, label: "Speech (TTS)" },
  { value: GenerateAudioRequestKind.sfx, label: "Sound effect" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function MediaPreview({ asset }: { asset: MediaAsset }) {
  if (asset.status !== "ready") {
    return (
      <div className="flex h-40 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
        {asset.status === "failed" ? "Generation failed" : "Pending…"}
      </div>
    );
  }
  if (asset.kind === "image" || asset.kind === "video") {
    return (
      <div
        className="overflow-hidden rounded-md border border-border bg-muted"
        data-testid={`media-preview-${asset.id}`}
      >
        <img
          src={asset.fileUrl}
          alt={asset.prompt}
          loading="lazy"
          className="block aspect-video w-full object-contain"
        />
      </div>
    );
  }
  // audio
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <audio
        controls
        preload="metadata"
        src={asset.fileUrl}
        className="w-full"
        data-testid={`media-audio-${asset.id}`}
      />
    </div>
  );
}

function HardwareBanner() {
  const hwQuery = useGetMediaHardwareCapabilities();
  const hw = hwQuery.data?.data;
  if (!hw) return null;
  const tierColor =
    hw.recommendedTier === "high"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : hw.recommendedTier === "mid"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "bg-muted text-muted-foreground";
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/30 p-3 text-xs"
      data-testid="media-hardware-banner"
    >
      <Cpu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <span className="font-medium">Local hardware</span>
      <Badge variant="outline" className={tierColor}>
        {hw.recommendedTier} tier
      </Badge>
      <span className="text-muted-foreground">
        {hw.cpuCount} CPUs · {Math.round(hw.freeRamMb / 1024)} GB free /{" "}
        {Math.round(hw.totalRamMb / 1024)} GB total
      </span>
      <span className="ml-auto text-[10px] text-muted-foreground">
        Heavier models (SDXL, FLUX, AnimateDiff) light up automatically as
        more RAM becomes available — Tier 1 stubs always work.
      </span>
    </div>
  );
}

export default function MediaPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageStyle, setImageStyle] = useState<GenerateImageRequestStyle>(
    GenerateImageRequestStyle.illustration,
  );
  const [audioPrompt, setAudioPrompt] = useState("");
  const [audioKind, setAudioKind] = useState<GenerateAudioRequestKind>(
    GenerateAudioRequestKind.music,
  );
  const [audioDurationMs, setAudioDurationMs] = useState(2500);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoDurationMs, setVideoDurationMs] = useState(4000);

  const listParams = useMemo(
    () => (filter === "all" ? { limit: 60 } : { limit: 60, kind: filter }),
    [filter],
  );
  const listQuery = useListMediaAssets(listParams);
  const assets = listQuery.data?.data.items ?? [];

  const invalidateLibrary = () => {
    void qc.invalidateQueries({ queryKey: ["/media/assets"] });
    void qc.invalidateQueries();
  };

  const generateImage = useGenerateImage({
    mutation: {
      onSuccess: () => {
        setImagePrompt("");
        invalidateLibrary();
      },
    },
  });
  const generateAudio = useGenerateAudio({
    mutation: {
      onSuccess: () => {
        setAudioPrompt("");
        invalidateLibrary();
      },
    },
  });
  const generateVideo = useGenerateVideo({
    mutation: {
      onSuccess: () => {
        setVideoPrompt("");
        invalidateLibrary();
      },
    },
  });
  const upscale = useUpscaleImage({
    mutation: { onSuccess: invalidateLibrary },
  });
  const removeBg = useRemoveImageBackground({
    mutation: { onSuccess: invalidateLibrary },
  });
  const deleteAsset = useDeleteMediaAsset({
    mutation: { onSuccess: invalidateLibrary },
  });

  const submitImage = () => {
    if (!imagePrompt.trim()) return;
    generateImage.mutate({
      data: { prompt: imagePrompt.trim(), style: imageStyle },
    });
  };
  const submitAudio = () => {
    if (!audioPrompt.trim()) return;
    generateAudio.mutate({
      data: {
        prompt: audioPrompt.trim(),
        kind: audioKind,
        durationMs: audioDurationMs,
      },
    });
  };
  const submitVideo = () => {
    if (!videoPrompt.trim()) return;
    generateVideo.mutate({
      data: { prompt: videoPrompt.trim(), durationMs: videoDurationMs },
    });
  };

  const lastError =
    generateImage.error ??
    generateAudio.error ??
    generateVideo.error ??
    upscale.error ??
    removeBg.error ??
    deleteAsset.error ??
    listQuery.error;

  return (
    <OperatorLayout
      title="Media"
      description="Generate images, audio, and short video locally — every asset stays in your workspace sandbox."
    >
      <div className="space-y-6 p-6">
        <HardwareBanner />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
              Generate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="image" className="w-full">
              <TabsList className="grid w-full grid-cols-3" data-testid="generate-tabs">
                <TabsTrigger value="image" data-testid="tab-image">
                  <ImageIcon className="mr-1 h-3 w-3" />
                  Image
                </TabsTrigger>
                <TabsTrigger value="audio" data-testid="tab-audio">
                  <Music className="mr-1 h-3 w-3" />
                  Audio
                </TabsTrigger>
                <TabsTrigger value="video" data-testid="tab-video">
                  <Video className="mr-1 h-3 w-3" />
                  Video
                </TabsTrigger>
              </TabsList>

              <TabsContent value="image" className="mt-4 space-y-3">
                <Textarea
                  data-testid="input-image-prompt"
                  value={imagePrompt}
                  onChange={(e) => setImagePrompt(e.target.value)}
                  placeholder="A serene mountain lake at golden hour, photorealistic"
                  className="min-h-[80px]"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Style
                  </label>
                  <select
                    value={imageStyle}
                    onChange={(e) =>
                      setImageStyle(e.target.value as GenerateImageRequestStyle)
                    }
                    data-testid="select-image-style"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {IMAGE_STYLES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    onClick={submitImage}
                    disabled={generateImage.isPending || !imagePrompt.trim()}
                    data-testid="button-generate-image"
                    className="ml-auto"
                  >
                    {generateImage.isPending ? "Generating…" : "Generate image"}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="audio" className="mt-4 space-y-3">
                <Textarea
                  data-testid="input-audio-prompt"
                  value={audioPrompt}
                  onChange={(e) => setAudioPrompt(e.target.value)}
                  placeholder="Calm ambient pad in C minor, slowly evolving"
                  className="min-h-[80px]"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Type
                  </label>
                  <select
                    value={audioKind}
                    onChange={(e) =>
                      setAudioKind(e.target.value as GenerateAudioRequestKind)
                    }
                    data-testid="select-audio-kind"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {AUDIO_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Length
                  </label>
                  <Input
                    type="number"
                    min={250}
                    max={30000}
                    step={250}
                    value={audioDurationMs}
                    onChange={(e) =>
                      setAudioDurationMs(Math.max(250, Number(e.target.value) || 0))
                    }
                    data-testid="input-audio-duration"
                    className="h-9 w-28"
                  />
                  <span className="text-xs text-muted-foreground">ms</span>
                  <Button
                    onClick={submitAudio}
                    disabled={generateAudio.isPending || !audioPrompt.trim()}
                    data-testid="button-generate-audio"
                    className="ml-auto"
                  >
                    {generateAudio.isPending ? "Generating…" : "Generate audio"}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="video" className="mt-4 space-y-3">
                <Textarea
                  data-testid="input-video-prompt"
                  value={videoPrompt}
                  onChange={(e) => setVideoPrompt(e.target.value)}
                  placeholder="A neon city skyline pulsing with traffic lights"
                  className="min-h-[80px]"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Length
                  </label>
                  <Input
                    type="number"
                    min={500}
                    max={10000}
                    step={500}
                    value={videoDurationMs}
                    onChange={(e) =>
                      setVideoDurationMs(Math.max(500, Number(e.target.value) || 0))
                    }
                    data-testid="input-video-duration"
                    className="h-9 w-28"
                  />
                  <span className="text-xs text-muted-foreground">ms</span>
                  <Button
                    onClick={submitVideo}
                    disabled={generateVideo.isPending || !videoPrompt.trim()}
                    data-testid="button-generate-video"
                    className="ml-auto"
                  >
                    {generateVideo.isPending ? "Generating…" : "Generate video"}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <ErrorBanner error={lastError} />

        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Library</h3>
          <span className="text-xs text-muted-foreground">
            ({assets.length} asset{assets.length === 1 ? "" : "s"})
          </span>
          <div className="ml-auto flex gap-1" role="tablist" aria-label="Filter">
            {(["all", "image", "audio", "video"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                onClick={() => setFilter(f)}
                data-testid={`filter-${f}`}
              >
                {f}
              </Button>
            ))}
          </div>
        </div>

        {assets.length === 0 && !listQuery.isLoading ? (
          <EmptyState
            icon={<ImageIcon className="h-6 w-6" />}
            title="No media yet"
            description="Use the generators above and your assets will appear here."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {assets.map((asset) => (
              <Card key={asset.id} data-testid={`media-card-${asset.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="line-clamp-2 text-sm">
                        {asset.prompt}
                      </CardTitle>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {asset.kind}
                        </Badge>
                        {asset.style ? (
                          <Badge variant="outline" className="text-[10px]">
                            {asset.style}
                          </Badge>
                        ) : null}
                        <Badge variant="outline" className="text-[10px]">
                          {asset.modelUsed}
                        </Badge>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete asset"
                      onClick={() => deleteAsset.mutate({ id: asset.id })}
                      disabled={deleteAsset.isPending}
                      data-testid={`button-delete-${asset.id}`}
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <MediaPreview asset={asset} />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <a
                      href={asset.fileUrl}
                      download={`${asset.id}`}
                      data-testid={`button-download-${asset.id}`}
                    >
                      <Button variant="outline" size="sm">
                        <Download className="mr-1 h-3 w-3" />
                        Download
                      </Button>
                    </a>
                    {asset.kind === "image" ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            upscale.mutate({ id: asset.id, data: { scale: 2 } })
                          }
                          disabled={upscale.isPending}
                          data-testid={`button-upscale-${asset.id}`}
                        >
                          <Wand2 className="mr-1 h-3 w-3" />
                          Upscale 2×
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => removeBg.mutate({ id: asset.id })}
                          disabled={removeBg.isPending}
                          data-testid={`button-removebg-${asset.id}`}
                        >
                          <Eraser className="mr-1 h-3 w-3" />
                          Remove BG
                        </Button>
                      </>
                    ) : null}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {formatBytes(asset.sizeBytes)}
                    {asset.width && asset.height
                      ? ` · ${asset.width}×${asset.height}`
                      : ""}
                    {asset.durationMs ? ` · ${asset.durationMs}ms` : ""} ·{" "}
                    {new Date(asset.createdAt).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </OperatorLayout>
  );
}
