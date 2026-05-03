/**
 * Public service status page (Task #34).
 *
 * Renders the snapshot returned by `/api/status-page/` — overall
 * traffic-light, per-component health, and active incidents.
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Wrench,
  XCircle,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  getPublicStatus,
  type PublicStatusSnapshot,
} from "@/lib/support-api";

const COMPONENT_TONE: Record<
  string,
  { className: string; icon: typeof CheckCircle2; label: string }
> = {
  operational: {
    className: "text-emerald-600 dark:text-emerald-400",
    icon: CheckCircle2,
    label: "Operational",
  },
  degraded: {
    className: "text-amber-600 dark:text-amber-400",
    icon: CircleAlert,
    label: "Degraded performance",
  },
  partial_outage: {
    className: "text-amber-600 dark:text-amber-400",
    icon: AlertTriangle,
    label: "Partial outage",
  },
  major_outage: {
    className: "text-red-600 dark:text-red-400",
    icon: XCircle,
    label: "Major outage",
  },
  maintenance: {
    className: "text-sky-600 dark:text-sky-400",
    icon: Wrench,
    label: "Maintenance",
  },
};

const OVERALL_BANNER: Record<string, { className: string; label: string }> = {
  operational: {
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    label: "All systems operational",
  },
  degraded: {
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    label: "Some systems are degraded",
  },
  partial_outage: {
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    label: "Partial service outage",
  },
  major_outage: {
    className: "bg-red-500/10 text-red-700 dark:text-red-300",
    label: "Major service outage",
  },
  maintenance: {
    className: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    label: "Scheduled maintenance in progress",
  },
};

const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-red-500/15 text-red-600 dark:text-red-400",
  major: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  minor: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  none: "bg-muted text-muted-foreground",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function StatusPage() {
  const [snap, setSnap] = useState<PublicStatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await getPublicStatus();
        if (!active) return;
        setSnap(data);
        setError(null);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    // tier-review: bounded — single fixed-interval polling, no growth
    const handle = window.setInterval(load, 30_000);
    return () => {
      active = false;
      window.clearInterval(handle);
    };
  }, []);

  const overall = snap?.overall ?? "operational";
  const banner = OVERALL_BANNER[overall] ?? OVERALL_BANNER.operational;

  return (
    <main
      className="mx-auto w-full max-w-4xl space-y-6 p-6"
      data-testid="status-page"
    >
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">
          Omninity Operator Status
        </h1>
        <p className="text-muted-foreground">
          Real-time service health for the Operator marketplace, mobile sync,
          payments and update server.
        </p>
      </header>

      <div
        className={`rounded-lg p-4 text-base font-medium ${banner.className}`}
        data-testid="status-overall-banner"
      >
        {loading ? "Checking systems…" : banner.label}
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load status: {error}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Components</CardTitle>
          <CardDescription>Current health of each service.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(snap?.components ?? []).map((c) => {
            const tone = COMPONENT_TONE[c.status] ?? COMPONENT_TONE.operational;
            const Icon = tone.icon;
            return (
              <div
                key={c.id}
                className="flex items-center justify-between rounded-md border p-3"
                data-testid={`status-component-${c.componentKey}`}
              >
                <div>
                  <div className="font-medium">{c.label}</div>
                  {c.message ? (
                    <div className="text-xs text-muted-foreground">
                      {c.message}
                    </div>
                  ) : null}
                </div>
                <div className={`flex items-center gap-2 ${tone.className}`}>
                  <Icon className="h-4 w-4" />
                  <span className="text-sm">{tone.label}</span>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active incidents</CardTitle>
          <CardDescription>
            {snap && snap.activeIncidents.length === 0
              ? "No incidents reported in the last day."
              : "Open incidents being investigated by the OP team."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(snap?.activeIncidents ?? []).map((i) => (
            <div
              key={i.id}
              className="rounded-md border p-3"
              data-testid={`status-incident-${i.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium">{i.title}</div>
                <Badge className={SEVERITY_TONE[i.severity] ?? SEVERITY_TONE.minor}>
                  {i.severity}
                </Badge>
              </div>
              {i.body ? (
                <div className="mt-1 text-sm text-muted-foreground">{i.body}</div>
              ) : null}
              <div className="mt-2 text-xs text-muted-foreground">
                Status: {i.status} · started {formatTime(i.startedAt)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
