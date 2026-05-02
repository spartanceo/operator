import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type Approval,
  ApprovalDecisionRequestDecision,
  useDecideApproval,
  useUpsertOnboardingProfile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { RiskBadge } from "./risk-badge";
import { ErrorBanner } from "./error-banner";

interface ApprovalModalProps {
  approval: Approval | null;
  riskLevel?: string;
  toolName?: string;
  inputPreview?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDecided?: (approval: Approval) => void;
  /**
   * When true, render the one-time "this is an approval gate" tooltip
   * card above the action buttons. The host (chat page) clears this flag
   * by PUTting `approvalTooltipSeen=true` to the onboarding profile, so
   * the tooltip never reappears.
   */
  showFirstApprovalTooltip?: boolean;
}

export function ApprovalModal({
  approval,
  riskLevel,
  toolName,
  inputPreview,
  open,
  onOpenChange,
  onDecided,
  showFirstApprovalTooltip = false,
}: ApprovalModalProps) {
  const [note, setNote] = useState("");
  const qc = useQueryClient();
  const markTooltipSeen = useUpsertOnboardingProfile();
  const decide = useDecideApproval({
    mutation: {
      onSuccess: (resp) => {
        void qc.invalidateQueries();
        onDecided?.(resp.data);
        setNote("");
        onOpenChange(false);
        if (showFirstApprovalTooltip) {
          markTooltipSeen.mutate({ data: { approvalTooltipSeen: true } });
        }
      },
    },
  });

  if (!approval) return null;

  const submit = (decision: keyof typeof ApprovalDecisionRequestDecision) => {
    decide.mutate({
      id: approval.id,
      data: {
        decision: ApprovalDecisionRequestDecision[decision],
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid={`approval-modal-${approval.id}`}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>Approval required</span>
            {riskLevel ? <RiskBadge risk={riskLevel} /> : null}
          </DialogTitle>
          <DialogDescription>
            {approval.summary || "An agent step needs your approval before it can run."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {toolName ? (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Tool
              </p>
              <p className="font-mono text-sm text-foreground">{toolName}</p>
            </div>
          ) : null}

          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Reason
            </p>
            <p className="mt-1 text-sm text-foreground">{approval.reason}</p>
          </div>

          {inputPreview ? (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Input
              </p>
              <pre
                className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs"
                data-testid="approval-input-preview"
              >
                {inputPreview}
              </pre>
            </div>
          ) : null}

          <div>
            <label
              htmlFor="approval-note"
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Note (optional)
            </label>
            <Textarea
              id="approval-note"
              data-testid="input-approval-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a brief reason for your decision…"
              className="mt-1 min-h-[72px]"
            />
          </div>

          {showFirstApprovalTooltip ? (
            <div
              className={cn(
                "flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-xs text-foreground",
              )}
              data-testid="first-approval-tooltip"
            >
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <strong className="font-medium">Approval gates</strong> appear
                whenever a step writes outside your machine, spends money, or
                sends data over the network. Approve to continue, deny to stop
                the agent. Your choice is logged in Privacy.
              </span>
            </div>
          ) : null}

          <ErrorBanner error={decide.error} />
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => submit("denied")}
            disabled={decide.isPending}
            data-testid="button-deny-approval"
          >
            Deny
          </Button>
          <Button
            onClick={() => submit("approved")}
            disabled={decide.isPending}
            data-testid="button-approve-approval"
          >
            {decide.isPending ? "Submitting…" : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
