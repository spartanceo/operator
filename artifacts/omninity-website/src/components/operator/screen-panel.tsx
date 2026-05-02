import { Monitor, Camera } from "lucide-react";
import { useGetDesktopSessionScreen } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ScreenPanelProps {
  sessionId: string | null;
  className?: string;
}

export function ScreenPanel({ sessionId, className }: ScreenPanelProps) {
  const screenQuery = useGetDesktopSessionScreen(
    sessionId ?? "",
    {
      query: {
        enabled: Boolean(sessionId),
        refetchInterval: 3000,
      } as never,
    },
  );
  const frame = screenQuery.data?.data ?? null;

  return (
    <Card className={cn("border-card-border", className)} data-testid="screen-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          Live screen
        </CardTitle>
        {frame ? (
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-wide"
            data-testid="screen-source-badge"
          >
            {frame.source}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>
        {!sessionId ? (
          <p className="text-xs italic text-muted-foreground">
            Start a session to stream the desktop.
          </p>
        ) : frame ? (
          <figure className="space-y-2">
            <div className="flex items-center justify-center rounded-md border border-border bg-muted/40 p-4">
              <img
                src={`data:${frame.mimeType};base64,${frame.data}`}
                alt={`Desktop frame at ${frame.capturedAt}`}
                className="max-h-64 w-auto max-w-full"
                data-testid="screen-frame"
              />
            </div>
            <figcaption className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <Camera className="h-3 w-3" aria-hidden="true" />
              {frame.width}×{frame.height}
              <span>·</span>
              <span>{new Date(frame.capturedAt).toLocaleTimeString()}</span>
            </figcaption>
          </figure>
        ) : (
          <p className="text-xs italic text-muted-foreground">
            Waiting for the first frame…
          </p>
        )}
      </CardContent>
    </Card>
  );
}
