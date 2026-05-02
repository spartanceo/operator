/**
 * TelemetryCard — opt-in analytics, performance metrics, onboarding, and
 * marketplace event consent + the user-facing "what we collect" panel and
 * the destructive erasure button.
 *
 * Default-OFF is enforced by the API. The only thing this component does
 * differently from a plain Switch group is that it auto-saves on toggle
 * (rather than waiting for a global Save button) so the user's consent
 * intent is captured the moment they flip the switch.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useGetTelemetryConsent,
  useUpdateTelemetryConsent,
  useEraseTelemetryData,
  type OptInTelemetryConsent as TelemetryConsent,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorBanner } from "@/components/operator/error-banner";

interface ConsentToggle {
  flag: keyof Pick<
    TelemetryConsent,
    | "optInUsage"
    | "optInPerformance"
    | "optInCrashes"
    | "optInOnboarding"
    | "optInMarketplace"
  >;
  label: string;
  description: string;
  testId: string;
}

const TOGGLES: readonly ConsentToggle[] = [
  {
    flag: "optInUsage",
    label: "Feature usage",
    description:
      "Anonymized events when you visit pages, run tools, or install skills. No content, no prompts.",
    testId: "switch-telemetry-usage",
  },
  {
    flag: "optInPerformance",
    label: "Performance metrics",
    description:
      "Startup time, agent latency, model inference duration, and memory pressure. Numbers only.",
    testId: "switch-telemetry-performance",
  },
  {
    flag: "optInCrashes",
    label: "Crash reports",
    description:
      "Submit crash reports after you review them. Stack traces are scrubbed of file paths, emails, and tokens.",
    testId: "switch-telemetry-crashes",
  },
  {
    flag: "optInOnboarding",
    label: "Onboarding funnel",
    description:
      "Which step of the setup wizard you reached. Helps us spot where new users drop off.",
    testId: "switch-telemetry-onboarding",
  },
  {
    flag: "optInMarketplace",
    label: "Marketplace events",
    description:
      "Which skills you browsed, installed, or rated. We never include free-text content.",
    testId: "switch-telemetry-marketplace",
  },
];

export function TelemetryCard() {
  const qc = useQueryClient();
  const consentQuery = useGetTelemetryConsent();
  const update = useUpdateTelemetryConsent({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });
  const erase = useEraseTelemetryData({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const [showDetails, setShowDetails] = useState(false);
  const [confirmingErase, setConfirmingErase] = useState(false);

  const consent = consentQuery.data?.data.consent ?? null;

  const onToggle = (flag: ConsentToggle["flag"], next: boolean) => {
    update.mutate({ data: { [flag]: next } });
  };

  const onErase = () => {
    if (!confirmingErase) {
      setConfirmingErase(true);
      return;
    }
    erase.mutate(undefined, {
      onSettled: () => setConfirmingErase(false),
    });
  };

  const anyOn =
    consent !== null &&
    (consent.optInUsage ||
      consent.optInPerformance ||
      consent.optInCrashes ||
      consent.optInOnboarding ||
      consent.optInMarketplace);

  return (
    <Card className="lg:col-span-2" data-testid="card-telemetry">
      <CardHeader>
        <CardTitle className="text-base">
          Privacy & telemetry{" "}
          <span
            className={`ml-2 inline-block rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              anyOn
                ? "bg-emerald-500/10 text-emerald-500"
                : "bg-muted text-muted-foreground"
            }`}
            data-testid="badge-telemetry-status"
          >
            {anyOn ? "Some opt-ins on" : "All off"}
          </span>
        </CardTitle>
        <CardDescription className="text-xs">
          Every category is off by default. Nothing leaves your machine until
          you explicitly toggle a switch below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ErrorBanner error={consentQuery.error} />
        <ErrorBanner error={update.error} />
        <ErrorBanner error={erase.error} />

        {consentQuery.isLoading || consent === null ? (
          <p className="text-xs text-muted-foreground">Loading consent…</p>
        ) : (
          <div className="space-y-2">
            {TOGGLES.map((t) => (
              <div
                key={t.flag}
                className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t.label}</p>
                  <p className="text-xs text-muted-foreground">{t.description}</p>
                </div>
                <Switch
                  checked={consent[t.flag] === true}
                  onCheckedChange={(v) => onToggle(t.flag, v)}
                  disabled={update.isPending}
                  data-testid={t.testId}
                />
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="flex w-full items-center gap-1 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent"
          data-testid="button-telemetry-details"
        >
          {showDetails ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          What we collect (and what we don't)
        </button>

        {showDetails ? (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
            <p className="mb-2 font-medium">We collect</p>
            <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
              <li>Event names like <code>tool.invoked</code> or <code>page.viewed</code>.</li>
              <li>Numerical metrics (durations, RAM pressure, model tier).</li>
              <li>An anonymous per-install ID — random, never tied to you.</li>
              <li>OP version, OS platform name, hardware tier (low / mid / high / pro).</li>
            </ul>
            <p className="mb-2 mt-3 font-medium">We never collect</p>
            <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
              <li>Prompts, model responses, chat transcripts, or any free text you typed.</li>
              <li>Email addresses, passwords, tokens, or API keys (rejected by the privacy gate).</li>
              <li>File paths, file contents, screenshots, or audio.</li>
              <li>Your IP address (the dashboard aggregates by anonymous ID only).</li>
            </ul>
          </div>
        ) : null}

        <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Delete my telemetry data</p>
            <p className="text-xs text-muted-foreground">
              Wipes every recorded event, crash report, and consent decision
              on the server. Cannot be undone.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={onErase}
            disabled={erase.isPending}
            data-testid="button-telemetry-erase"
          >
            <Trash2 className="mr-1 h-3 w-3" />
            {erase.isPending
              ? "Deleting…"
              : confirmingErase
                ? "Click again to confirm"
                : "Delete"}
          </Button>
        </div>

        {erase.data ? (
          <p
            className="text-xs text-emerald-500"
            data-testid="text-telemetry-erase-receipt"
          >
            Deleted {erase.data.data.eventsDeleted} event(s) and{" "}
            {erase.data.data.crashesDeleted} crash report(s).
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
