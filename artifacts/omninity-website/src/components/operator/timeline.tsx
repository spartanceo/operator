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
            <JsonView value={output} emptyLabel="No output yet" />
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
