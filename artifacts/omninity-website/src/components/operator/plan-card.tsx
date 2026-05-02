import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AgentRun } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  pending: "text-muted-foreground",
  running: "text-amber-500",
  succeeded: "text-emerald-500",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

export function PlanCard({
  run,
  className,
}: {
  run: AgentRun;
  className?: string;
}) {
  const planLines = (run.plan ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (
    <Card className={cn("border-card-border", className)} data-testid={`plan-card-${run.id}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <span>Plan</span>
          <Badge
            variant="outline"
            className={cn("uppercase", STATUS_STYLES[run.status] ?? "")}
            data-testid={`plan-status-${run.status}`}
          >
            {run.status}
          </Badge>
        </CardTitle>
        {run.modelName ? (
          <span className="font-mono text-xs text-muted-foreground">
            {run.modelName}
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Goal
          </p>
          <p className="mt-1 text-sm text-foreground">{run.goal}</p>
        </div>

        {planLines.length > 0 ? (
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Plan
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-foreground">
              {planLines.map((line, idx) => (
                <li key={idx}>{line}</li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="text-xs italic text-muted-foreground">
            Planner has not produced a plan yet.
          </p>
        )}

        {run.summary ? (
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Summary
            </p>
            <p className="mt-1 text-sm text-foreground">{run.summary}</p>
          </div>
        ) : null}

        {run.error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {run.error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
