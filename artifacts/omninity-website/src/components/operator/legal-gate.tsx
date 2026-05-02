/**
 * Legal acceptance gate (Task #25).
 *
 * Renders a modal-style full-screen acceptance flow when:
 *   - Any legal document with `requiresAcceptance: true` has not yet been
 *     accepted at its current hash, OR
 *   - The age confirmation singleton has not yet been confirmed.
 *
 * Once cleared, the gate's children render normally. The gate is the
 * single source of truth for "may this user reach the operator UI?" —
 * the only thing in front of it is the onboarding wizard (which itself
 * collects no data until the gate is satisfied).
 */
import { useMemo, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import {
  getGetAgeConfirmationQueryKey,
  getGetLegalAcceptanceStateQueryKey,
  useGetAgeConfirmation,
  useGetLegalAcceptanceState,
  useGetLegalDocument,
  useRecordLegalAcceptance,
  useUpsertAgeConfirmation,
  type LegalDocumentSummary,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface LegalGateProps {
  children: React.ReactNode;
}

type Jurisdiction = "us" | "eu" | "uk" | "global";

export function LegalGate({ children }: LegalGateProps) {
  const acceptanceQuery = useGetLegalAcceptanceState();
  const ageQuery = useGetAgeConfirmation();

  const isLoading = acceptanceQuery.isLoading || ageQuery.isLoading;
  const pending = acceptanceQuery.data?.data.pending ?? [];
  const ageConfirmed = ageQuery.data?.data.confirmation?.confirmed === true;
  const minimums = ageQuery.data?.data.minimumAges ?? {
    us: 13,
    eu: 16,
    uk: 13,
    global: 16,
  };

  if (isLoading) {
    return (
      <div
        className="grid min-h-screen w-full place-items-center bg-background text-foreground"
        data-testid="legal-gate-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const needsAcceptance = pending.length > 0;
  const needsAge = !ageConfirmed;

  if (!needsAcceptance && !needsAge) {
    return <>{children}</>;
  }

  return (
    <div
      className="min-h-screen w-full bg-background text-foreground"
      data-testid="legal-gate"
    >
      <div className="mx-auto max-w-2xl px-5 py-12 md:px-8 md:py-16">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Before you continue
            </div>
            <h1 className="text-xl font-semibold tracking-tight">
              Confirm your agreements
            </h1>
          </div>
        </div>

        <p className="mt-4 max-w-prose text-sm text-muted-foreground">
          Omninity Operator stores everything locally on this device. Before
          we set up your workspace, please review and accept the documents
          below — and confirm you meet the minimum age for your region.
        </p>

        {needsAge ? <AgeGateBlock minimums={minimums} /> : null}

        {pending.length > 0 ? (
          <div className="mt-8 space-y-4">
            {pending.map((row) => (
              <PendingDocumentCard
                key={row.document.type}
                document={row.document}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface AgeGateBlockProps {
  minimums: { us: number; eu: number; uk: number; global: number };
}

function AgeGateBlock({ minimums }: AgeGateBlockProps) {
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>("global");
  const [confirmed, setConfirmed] = useState(false);
  const qc = useQueryClient();
  const upsert = useUpsertAgeConfirmation({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetAgeConfirmationQueryKey() });
      },
    },
  });
  const minAge = minimums[jurisdiction];

  return (
    <section
      className="mt-8 rounded-lg border border-border bg-card p-5"
      data-testid="legal-gate-age"
    >
      <div className="text-sm font-medium">Age confirmation</div>
      <p className="mt-1 text-xs text-muted-foreground">
        COPPA (US) and GDPR-K (EU) require us to confirm you meet the
        minimum age before collecting any personal data.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select
          value={jurisdiction}
          onValueChange={(v) => setJurisdiction(v as Jurisdiction)}
        >
          <SelectTrigger
            className="w-full sm:w-48"
            data-testid="legal-gate-age-jurisdiction"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="us">United States</SelectItem>
            <SelectItem value="eu">European Union</SelectItem>
            <SelectItem value="uk">United Kingdom</SelectItem>
            <SelectItem value="global">Other / Global</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(v === true)}
            data-testid="legal-gate-age-checkbox"
          />
          I am at least {minAge} years old
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          size="sm"
          disabled={!confirmed || upsert.isPending}
          onClick={() =>
            upsert.mutate({ data: { jurisdiction, confirmed: true } })
          }
          data-testid="legal-gate-age-submit"
        >
          {upsert.isPending ? "Saving…" : "Confirm age"}
        </Button>
      </div>
    </section>
  );
}

interface PendingDocumentCardProps {
  document: LegalDocumentSummary;
}

function PendingDocumentCard({ document }: PendingDocumentCardProps) {
  const [open, setOpen] = useState(false);
  const docQuery = useGetLegalDocument(document.type, {
    query: { enabled: open } as never,
  });
  const fullText = docQuery.data?.data.document.body ?? "";
  const qc = useQueryClient();
  const accept = useRecordLegalAcceptance({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({
          queryKey: getGetLegalAcceptanceStateQueryKey(),
        });
      },
    },
  });

  const summaryParas = useMemo(
    () => document.summary.split(/\n+/).map((p) => p.trim()).filter(Boolean),
    [document.summary],
  );

  return (
    <section
      className="rounded-lg border border-border bg-card p-5"
      data-testid={`legal-gate-doc-${document.type}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium">{document.title}</div>
        <div className="text-xs text-muted-foreground">v{document.version}</div>
      </div>
      <div className="mt-2 space-y-2 text-xs text-muted-foreground">
        {summaryParas.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      <div className="mt-3">
        <button
          type="button"
          className="text-xs underline-offset-4 hover:underline"
          onClick={() => setOpen((v) => !v)}
          data-testid={`legal-gate-toggle-${document.type}`}
        >
          {open ? "Hide full text" : "Read full text"}
        </button>
      </div>
      {open ? (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
          {docQuery.isLoading ? (
            <span className="text-muted-foreground">Loading…</span>
          ) : (
            <pre className="whitespace-pre-wrap font-sans">{fullText}</pre>
          )}
        </div>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button
          size="sm"
          disabled={accept.isPending}
          onClick={() =>
            accept.mutate({ data: { documentType: document.type } })
          }
          data-testid={`legal-gate-accept-${document.type}`}
        >
          {accept.isPending ? "Recording…" : "I accept"}
        </Button>
      </div>
    </section>
  );
}
