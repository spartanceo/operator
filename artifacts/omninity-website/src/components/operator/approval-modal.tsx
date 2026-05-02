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
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
}

export function ApprovalModal({
  approval,
  riskLevel,
  toolName,
  inputPreview,
  open,
  onOpenChange,
  onDecided,
}: ApprovalModalProps) {
  const [note, setNote] = useState("");
  const qc = useQueryClient();
  const decide = useDecideApproval({
    mutation: {
      onSuccess: (resp) => {
        void qc.invalidateQueries();
        onDecided?.(resp.data);
        setNote("");
        onOpenChange(false);
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
