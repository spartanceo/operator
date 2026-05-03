/**
 * Privacy Dashboard — central control panel for everything the agent
 * does that touches your data or the network.
 *
 * Sections:
 *   1. Privacy Meter (header)
 *   2. Per-feature toggles (Settings)
 *   3. Data inventory ("what's on my machine") + storage usage
 *   4. Network call log ("what's been shared") + 30-day summary
 *   5. Skill-level permission grid
 *   6. Data rights — export, delete-by-category, GDPR erasure
 *   7. Privacy event audit log (existing)
 */
import { useMemo, useState } from "react";
import {
  Activity,
  Database,
  Download,
  HardDrive,
  Mail,
  Network,
  Shield,
  Sparkles,
  Trash2,
} from "lucide-react";

import { OperatorLayout } from "@/components/operator/layout";
import { PrivacyMeter } from "@/components/operator/privacy-meter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  exportPrivacyBundle,
  useCancelErasureRequest,
  useCreateErasureRequest,
  useDeleteDataCategory,
  useGetDataInventory,
  useGetNetworkCallsSummary,
  useGetPrivacyMeter,
  useGetPrivacySettings,
  useListDataCategories,
  useListErasureRequests,
  useListNetworkCalls,
  useListPrivacyEvents,
  useListSkillPermissions,
  useSetSkillPermission,
  useUpdatePrivacySettings,
} from "@workspace/api-client-react";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { cn } from "@/lib/utils";

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${n} B`;
  const k = n / 1024;
  if (k < 1024) return `${k.toFixed(1)} KB`;
  const m = k / 1024;
  if (m < 1024) return `${m.toFixed(1)} MB`;
  return `${(m / 1024).toFixed(2)} GB`;
}

const SETTINGS_DEFINITIONS: Array<{
  key:
    | "allowExternalModels"
    | "allowMarketplaceUsageStats"
    | "allowIntegrationDataReads"
    | "allowSkillNetworkCalls";
  label: string;
  description: string;
}> = [
  {
    key: "allowExternalModels",
    label: "Use external models",
    description:
      "Permit the agent to send prompts to cloud-hosted LLMs. When off, only locally-hosted models run.",
  },
  {
    key: "allowMarketplaceUsageStats",
    label: "Share marketplace usage stats",
    description:
      "Send anonymised install / rating events to skill creators so they see how their work performs.",
  },
  {
    key: "allowIntegrationDataReads",
    label: "Read from connected integrations",
    description:
      "Let the agent pull data from your connected providers (Notion, Slack, etc.) when relevant.",
  },
  {
    key: "allowSkillNetworkCalls",
    label: "Allow skills to make network calls",
    description:
      "Master switch for any installed skill to make outbound HTTP requests, even when individual permissions are granted.",
  },
];

function SettingsCard() {
  const settingsQ = useGetPrivacySettings();
  const update = useUpdatePrivacySettings();
  const settings = settingsQ.data?.data;

  return (
    <Card data-testid="card-privacy-settings">
      <CardHeader>
        <CardTitle className="text-base">Per-feature privacy toggles</CardTitle>
        <CardDescription className="text-xs">
          Default-deny: every channel is off until you explicitly turn it on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorBanner error={settingsQ.error} />
        <ErrorBanner error={update.error} title="Update failed" />
        {SETTINGS_DEFINITIONS.map((def) => (
          <div
            key={def.key}
            className="flex items-start justify-between gap-4 border-b pb-3 last:border-b-0 last:pb-0"
          >
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-medium">{def.label}</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {def.description}
              </p>
            </div>
            <Switch
              data-testid={`toggle-${def.key}`}
              checked={settings ? (settings as any)[def.key] : false}
              disabled={!settings || update.isPending}
              onCheckedChange={(checked) =>
                update.mutate({ data: { [def.key]: checked } })
              }
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function InventoryCard() {
  const invQ = useGetDataInventory();
  const inv = invQ.data?.data;

  return (
    <Card data-testid="card-inventory">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <HardDrive className="h-4 w-4" /> What&apos;s on my machine
        </CardTitle>
        <CardDescription className="text-xs">
          Every category of data the agent has stored locally.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ErrorBanner error={invQ.error} />
        {inv ? (
          <>
            <div className="mb-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border p-2">
                <p className="text-[10px] uppercase text-muted-foreground">
                  Items
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {inv.totalItems.toLocaleString()}
                </p>
              </div>
              <div className="rounded-md border p-2">
                <p className="text-[10px] uppercase text-muted-foreground">
                  Database
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {fmtBytes(inv.databaseBytes)}
                </p>
              </div>
              <div className="rounded-md border p-2">
                <p className="text-[10px] uppercase text-muted-foreground">
                  Workspace
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {fmtBytes(inv.workspaceBytes)}
                </p>
              </div>
            </div>
            <ul className="divide-y divide-border text-sm">
              {inv.categories.map((c: any) => (
                <li
                  key={c.key}
                  className="flex items-center justify-between py-2"
                  data-testid={`inv-${c.key}`}
                >
                  <div className="min-w-0">
                    <p className="font-medium">{c.label}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {c.description}
                    </p>
                  </div>
                  <Badge variant="outline" className="tabular-nums">
                    {c.itemCount.toLocaleString()}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Loading inventory…</p>
        )}
      </CardContent>
    </Card>
  );
}

function NetworkCallsCard() {
  const summaryQ = useGetNetworkCallsSummary();
  const callsQ = useListNetworkCalls({ limit: 50 });
  const summary = summaryQ.data?.data as any;
  const calls = (((callsQ.data?.data as any)?.items ?? []) as any[]);

  return (
    <Card data-testid="card-network-calls">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Network className="h-4 w-4" /> What&apos;s been shared
        </CardTitle>
        <CardDescription className="text-xs">
          Trailing 30 days of outbound network calls.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ErrorBanner error={summaryQ.error} />
        <ErrorBanner error={callsQ.error} />
        {summary ? (
          <div className="mb-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            <div className="rounded-md border p-2">
              <p className="text-[10px] uppercase text-muted-foreground">
                Total calls
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {summary.totalCalls.toLocaleString()}
              </p>
            </div>
            <div className="rounded-md border p-2">
              <p className="text-[10px] uppercase text-muted-foreground">
                User-initiated
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {summary.userInitiated.toLocaleString()}
              </p>
            </div>
            <div className="rounded-md border p-2">
              <p className="text-[10px] uppercase text-muted-foreground">
                Automatic
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {summary.automatic.toLocaleString()}
              </p>
            </div>
            <div className="rounded-md border p-2">
              <p className="text-[10px] uppercase text-muted-foreground">
                Sent / Recv
              </p>
              <p className="text-sm font-semibold tabular-nums">
                {fmtBytes(summary.totalBytesSent)} / {fmtBytes(summary.totalBytesReceived)}
              </p>
            </div>
          </div>
        ) : null}

        {summary && summary.byDomain.length > 0 ? (
          <div className="mb-4">
            <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Top domains
            </p>
            <ul className="space-y-1">
              {summary.byDomain.slice(0, 8).map((d: any) => (
                <li
                  key={d.domain}
                  className="flex items-center justify-between rounded-md border px-2 py-1 text-xs"
                >
                  <span className="font-mono">{d.domain}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {d.count} {d.count === 1 ? "call" : "calls"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          Recent calls
        </p>
        {calls.length === 0 ? (
          <EmptyState
            icon={<Network className="h-6 w-6" />}
            title="No outbound network calls recorded"
            description="When the agent contacts an external service, it will appear here."
          />
        ) : (
          <ul className="divide-y divide-border text-xs">
            {calls.map((c: any) => (
              <li
                key={c.id}
                className="grid grid-cols-[1fr_auto] gap-2 py-2"
                data-testid={`net-${c.id}`}
              >
                <div className="min-w-0">
                  <p className="font-mono text-foreground">{c.domain}</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {c.purpose} · {c.dataType}
                  </p>
                </div>
                <div className="text-right">
                  <Badge
                    variant={c.initiator === "user" ? "secondary" : "outline"}
                  >
                    {c.initiator}
                  </Badge>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {new Date(c.createdAt).toLocaleString()}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SkillPermissionsCard() {
  const permsQ = useListSkillPermissions();
  const setPerm = useSetSkillPermission();
  const skills = permsQ.data?.data.items ?? [];

  return (
    <Card data-testid="card-skill-permissions">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> Skill permissions
        </CardTitle>
        <CardDescription className="text-xs">
          Grant or revoke individual capabilities for each installed skill.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ErrorBanner error={permsQ.error} />
        <ErrorBanner error={setPerm.error} title="Update failed" />
        {skills.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-6 w-6" />}
            title="No skills installed"
            description="Install a skill from the marketplace to manage its permissions."
          />
        ) : (
          <div className="space-y-4">
            {skills.map((s) => (
              <div
                key={s.skillId}
                className="rounded-md border p-3"
                data-testid={`perm-skill-${s.slug}`}
              >
                <div className="mb-2 flex items-baseline justify-between">
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {s.slug}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {s.permissions.map((p) => (
                    <label
                      key={p.permission}
                      className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
                    >
                      <span className="font-mono">{p.permission}</span>
                      <Switch
                        data-testid={`perm-${s.slug}-${p.permission}`}
                        checked={p.granted}
                        disabled={setPerm.isPending}
                        onCheckedChange={(granted) =>
                          setPerm.mutate({
                            data: {
                              skillId: s.skillId,
                              permission: p.permission as never,
                              granted,
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DataRightsCard() {
  const categoriesQ = useListDataCategories();
  const deleteCat = useDeleteDataCategory();
  const erasuresQ = useListErasureRequests({ limit: 20 });
  const createErasure = useCreateErasureRequest();
  const cancelErasure = useCancelErasureRequest();

  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");

  const categories = (((categoriesQ.data?.data as any)?.items ?? []) as any[]);
  const erasures = (((erasuresQ.data?.data as any)?.items ?? []) as any[]);

  const onExport = async () => {
    setExportBusy(true);
    setExportError(null);
    try {
      const res = await exportPrivacyBundle();
      const blob = new Blob([JSON.stringify(res.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `omninity-data-export-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExportBusy(false);
    }
  };

  const onDeleteCategory = (key: string, label: string) => {
    if (
      !window.confirm(
        `Permanently delete every "${label}" record? This cannot be undone.`,
      )
    ) {
      return;
    }
    deleteCat.mutate({ data: { category: key, confirm: true } });
  };

  const onFileErasure = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    createErasure.mutate(
      { data: { requesterEmail: email, scope: "all", reason: reason || undefined } },
      {
        onSuccess: () => {
          setEmail("");
          setReason("");
        },
      },
    );
  };

  return (
    <Card data-testid="card-data-rights">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-4 w-4" /> Your data, your rights
        </CardTitle>
        <CardDescription className="text-xs">
          Export everything, wipe a single category, or file a formal GDPR
          erasure request.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            Export
          </h3>
          {exportError ? (
            <p className="mb-2 text-xs text-destructive">{exportError}</p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={exportBusy}
            data-testid="button-export-bundle"
          >
            <Download className="mr-1 h-3 w-3" />
            {exportBusy ? "Exporting…" : "Download full export bundle"}
          </Button>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            Delete by category
          </h3>
          <ErrorBanner error={categoriesQ.error} />
          <ErrorBanner error={deleteCat.error} title="Delete failed" />
          {deleteCat.data ? (
            <p className="mb-2 text-xs text-emerald-500">
              Deleted {deleteCat.data.data.deleted} {deleteCat.data.data.category}{" "}
              records.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {categories.map((c) => (
              <Button
                key={c.key}
                variant="ghost"
                size="sm"
                className="justify-start text-xs"
                onClick={() => onDeleteCategory(c.key, c.label)}
                disabled={deleteCat.isPending}
                data-testid={`del-${c.key}`}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                {c.label}
              </Button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            File a GDPR erasure request
          </h3>
          <ErrorBanner error={createErasure.error} title="Request failed" />
          <form onSubmit={onFileErasure} className="space-y-2">
            <div>
              <Label htmlFor="erasure-email" className="text-xs">
                Requester email
              </Label>
              <Input
                id="erasure-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                data-testid="input-erasure-email"
              />
            </div>
            <div>
              <Label htmlFor="erasure-reason" className="text-xs">
                Reason (optional)
              </Label>
              <Textarea
                id="erasure-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                data-testid="input-erasure-reason"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={!email || createErasure.isPending}
              data-testid="button-file-erasure"
            >
              <Mail className="mr-1 h-3 w-3" />
              File request
            </Button>
          </form>

          {erasures.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs">
              {erasures.map((r: any) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between rounded-md border px-2 py-1"
                  data-testid={`erasure-${r.id}`}
                >
                  <div className="min-w-0">
                    <p className="font-medium">{r.requesterEmail}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()} · {r.scope}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        r.status === "pending"
                          ? "secondary"
                          : r.status === "cancelled"
                            ? "outline"
                            : "default"
                      }
                    >
                      {r.status}
                    </Badge>
                    {r.status === "pending" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => cancelErasure.mutate({ id: r.id })}
                        disabled={cancelErasure.isPending}
                        data-testid={`cancel-${r.id}`}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  info: "text-muted-foreground",
  low: "text-sky-500",
  medium: "text-amber-500",
  high: "text-orange-500",
  critical: "text-destructive",
};

function EventLogCard() {
  const eventsQ = useListPrivacyEvents({ limit: 100 });
  const events = eventsQ.data?.data.items ?? [];

  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events) {
      counts[e.severity] = (counts[e.severity] ?? 0) + 1;
    }
    return counts;
  }, [events]);

  return (
    <Card data-testid="card-events">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4" /> Privacy event log
        </CardTitle>
        <CardDescription className="text-xs">
          Tamper-evident audit trail of every privacy-sensitive action.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ErrorBanner error={eventsQ.error} />
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {(["info", "low", "medium", "high", "critical"] as const).map((s) => (
            <div
              key={s}
              className="rounded-md border p-2 text-center"
              data-testid={`stat-${s}`}
            >
              <p className="text-[10px] uppercase text-muted-foreground">{s}</p>
              <p className={cn("text-lg font-semibold", SEVERITY_STYLES[s])}>
                {stats[s] ?? 0}
              </p>
            </div>
          ))}
        </div>
        {events.length === 0 ? (
          <EmptyState
            icon={<Shield className="h-6 w-6" />}
            title="No privacy events recorded yet"
          />
        ) : (
          <ul className="divide-y divide-border text-xs">
            {events.slice(0, 50).map((e) => (
              <li
                key={e.id}
                className="grid grid-cols-[110px_1fr] gap-3 py-2"
                data-testid={`event-${e.id}`}
              >
                <div>
                  <Badge
                    variant="outline"
                    className={cn("uppercase", SEVERITY_STYLES[e.severity])}
                  >
                    {e.severity}
                  </Badge>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="font-mono">{e.eventType}</p>
                  <p className="text-muted-foreground">
                    {e.actor} → {e.target}
                  </p>
                  {e.detail ? (
                    <p className="mt-1 truncate text-foreground/80">
                      {e.detail}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function PrivacyPage() {
  const meterQ = useGetPrivacyMeter();
  const meter = meterQ.data?.data as any;

  return (
    <OperatorLayout
      title="Privacy"
      description="Your data, your rules. Review what's stored, what's shared, and tighten controls."
    >
      <div className="space-y-6 p-6">
        <ErrorBanner error={meterQ.error} />
        {meter ? (
          <PrivacyMeter
            score={meter.score}
            band={meter.band}
            summary={meter.summary}
          />
        ) : (
          <PrivacyMeter score={100} band="green" summary="Computing…" />
        )}

        <Tabs defaultValue="settings">
          <TabsList>
            <TabsTrigger value="settings" data-testid="tab-settings">
              Settings
            </TabsTrigger>
            <TabsTrigger value="inventory" data-testid="tab-inventory">
              <Database className="mr-1 h-3 w-3" />
              Inventory
            </TabsTrigger>
            <TabsTrigger value="network" data-testid="tab-network">
              Network
            </TabsTrigger>
            <TabsTrigger value="skills" data-testid="tab-skills">
              Skills
            </TabsTrigger>
            <TabsTrigger value="rights" data-testid="tab-rights">
              Data rights
            </TabsTrigger>
            <TabsTrigger value="events" data-testid="tab-events">
              Events
            </TabsTrigger>
          </TabsList>
          <TabsContent value="settings" className="mt-4">
            <SettingsCard />
          </TabsContent>
          <TabsContent value="inventory" className="mt-4">
            <InventoryCard />
          </TabsContent>
          <TabsContent value="network" className="mt-4">
            <NetworkCallsCard />
          </TabsContent>
          <TabsContent value="skills" className="mt-4">
            <SkillPermissionsCard />
          </TabsContent>
          <TabsContent value="rights" className="mt-4">
            <DataRightsCard />
          </TabsContent>
          <TabsContent value="events" className="mt-4">
            <EventLogCard />
          </TabsContent>
        </Tabs>
      </div>
    </OperatorLayout>
  );
}
