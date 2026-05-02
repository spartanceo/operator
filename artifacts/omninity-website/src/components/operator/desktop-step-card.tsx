import {
  CheckCircle2,
  XCircle,
  Loader2,
  Pause,
  Play,
  ChevronRight,
} from "lucide-react";
import type { DesktopStep } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RiskBadge } from "./risk-badge";
import { cn } from "@/lib/utils";

interface DesktopStepCardProps {
  step: DesktopStep;
  onExecute: (stepId: string) => void;
  onApprove: (step: DesktopStep) => void;
  isPending: boolean;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-amber-500" />;
    case "awaiting_approval":
      return <Pause className="h-4 w-4 text-amber-500" />;
    case "skipped":
      return <XCircle className="h-4 w-4 text-muted-foreground" />;
    default:
      return <ChevronRight className="h-4 w-4 text-muted-foreground" />;
  }
}

export function DesktopStepCard({
  step,
  onExecute,
  onApprove,
  isPending,
}: DesktopStepCardProps) {
  const showApprove = step.status === "awaiting_approval";
  const showRun = step.status === "pending";

  return (
    <li
      className="rounded-md border border-border bg-card p-3"
      data-testid={`desktop-step-${step.id}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-1">
          <StatusIcon status={step.status} />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              #{step.stepIndex + 1}
            </span>
            <span className="text-sm font-medium text-foreground">
              {step.actionType}
            </span>
            <RiskBadge risk={step.riskLevel} />
            <Badge variant="outline" className="text-[10px] uppercase">
              {step.status.replace(/_/g, " ")}
            </Badge>
          </div>
          <p className="text-sm text-foreground">
            <span className="text-muted-foreground">target: </span>
            {step.targetDescription}
          </p>
          {step.inputValue ? (
            <p className="text-xs text-muted-foreground">
              input: <span className="font-mono">{step.inputValue}</span>
            </p>
          ) : null}
          {step.expectedState ? (
            <p className="text-xs text-muted-foreground">
              expected: {step.expectedState}
            </p>
          ) : null}
          {step.observedState ? (
            <p className="text-xs text-muted-foreground">
              observed: {step.observedState}
            </p>
          ) : null}
          {step.error ? (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
              role="alert"
            >
              {step.error}
            </div>
          ) : null}
        </div>
        <div className={cn("flex flex-col gap-2")}>
          {showApprove ? (
            <Button
              size="sm"
              variant="default"
              onClick={() => onApprove(step)}
              disabled={isPending}
              data-testid={`button-approve-step-${step.id}`}
            >
              Review
            </Button>
          ) : null}
          {showRun ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onExecute(step.id)}
              disabled={isPending}
              data-testid={`button-run-step-${step.id}`}
            >
              <Play className="mr-1 h-3 w-3" />
              Run
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
