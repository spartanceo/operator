/**
 * Super Admin dashboard — single page with tabbed sections that surface
 * the platform-wide views maintained by the OP core team:
 *   - Overview     → installs, MAU, churn, growth chart
 *   - Revenue      → MRR, platform/creator split, recent invoices
 *   - Skills       → top installs, top creators, trending categories
 *   - Moderation   → submission queue + abuse reports
 *   - Releases     → desktop release publish + force-update floor
 *   - Feature flags
 *
 * Pragmatic deviation (Task #7): we host this inside the existing
 * marketing/operator artifact under `/admin/super` rather than spinning
 * up a separate Vite app — keeps the design system, query client, and
 * auth context shared without breaking the local-first promise (the
 * desktop app never loads this route).
 */
import { useState } from "react";
import { Loader2, ShieldAlert, TrendingUp, DollarSign, Sparkles, Flag, Rocket } from "lucide-react";
import {
  useGetSuperAdminOverview,
  useGetSuperAdminRevenue,
  useGetSuperAdminSkillAnalytics,
  useListModerationQueue,
  useApproveModerationItem,
  useRejectModerationItem,
  useListAbuseReports,
  useResolveAbuseReport,
  useListFeatureFlags,
  useSetFeatureFlag,
  useListAppVersions,
  usePublishAppVersion,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card data-testid={`stat-${label.replace(/\s+/g, "-").toLowerCase()}`}>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

function fmtMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function OverviewTab() {
  const { data, isLoading } = useGetSuperAdminOverview();
  if (isLoading || !data) return <Loader2 className="h-5 w-5 animate-spin" />;
  const o = data.data as any;
  const maxInstall = Math.max(1, ...o.growthSeries.map((p: any) => p.installs));
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Total installs" value={o.totalInstalls} hint="Tenants provisioned" />
        <StatCard label="Total users" value={o.totalUsers} />
        <StatCard label="Enterprise orgs" value={o.enterpriseOrgs} />
        <StatCard label="Paid subscribers" value={o.paidSubscribers} />
        <StatCard label="DAU" value={o.dailyActiveUsers} />
        <StatCard label="WAU" value={o.weeklyActiveUsers} />
        <StatCard label="MAU" value={o.monthlyActiveUsers} />
        <StatCard label="Churn (30d)" value={`${(o.churnRate * 100).toFixed(2)}%`} />
      </div>
      <Card>
        <CardHeader><CardTitle>Install growth — last 14 days</CardTitle></CardHeader>
        <CardContent>
          <div className="flex h-32 items-end gap-1" data-testid="growth-chart">
            {o.growthSeries.map((p: any) => (
              <div key={p.date} className="flex-1" title={`${p.date}: ${p.installs}`}>
                <div
                  className="bg-primary/70 rounded-t"
                  style={{ height: `${(p.installs / maxInstall) * 100}%`, minHeight: 2 }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{o.growthSeries[0]?.date}</span>
            <span>{o.growthSeries[o.growthSeries.length - 1]?.date}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RevenueTab() {
  const { data, isLoading } = useGetSuperAdminRevenue();
  if (isLoading || !data) return <Loader2 className="h-5 w-5 animate-spin" />;
  const r = data.data as any;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Active subscribers" value={r.totalSubscribers} />
        <StatCard label="MRR" value={fmtMoney(r.monthlyRecurringCents)} />
        <StatCard label="Platform cut (30%)" value={fmtMoney(r.platformCutCents)} />
        <StatCard label="Creator pool (70%)" value={fmtMoney(r.creatorPoolCents)} hint={`Stripe payouts: ${r.stripePayoutStatus}`} />
      </div>
      <Card>
        <CardHeader><CardTitle>Recent invoices</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr><th className="py-2">Tenant</th><th>Status</th><th>Amount</th><th>Date</th></tr>
            </thead>
            <tbody>
              {r.recentInvoices.map((inv: any) => (
                <tr key={inv.id} className="border-t border-border/50">
                  <td className="py-2 font-mono text-xs">{inv.tenantId}</td>
                  <td><Badge variant={inv.status === "active" ? "default" : "secondary"}>{inv.status}</Badge></td>
                  <td>{fmtMoney(inv.amountCents)}</td>
                  <td className="text-muted-foreground">{new Date(inv.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
              {r.recentInvoices.length === 0 ? (
                <tr><td colSpan={4} className="py-4 text-center text-muted-foreground">No invoices yet</td></tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function SkillsTab() {
  const { data, isLoading } = useGetSuperAdminSkillAnalytics();
  if (isLoading || !data) return <Loader2 className="h-5 w-5 animate-spin" />;
  const s = data.data as any;
  return (
    <div className="grid gap-6 md:grid-cols-3">
      <Card>
        <CardHeader><CardTitle>Top installed skills</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            {s.topInstalled.map((sk: any, i: number) => (
              <li key={sk.slug} className="flex justify-between">
                <span><span className="text-muted-foreground mr-2">{i + 1}.</span>{sk.name}</span>
                <span className="font-mono text-xs">{sk.installs}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Top creators</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            {s.topEarning.map((c: any, i: number) => (
              <li key={c.creatorHandle} className="flex justify-between">
                <span><span className="text-muted-foreground mr-2">{i + 1}.</span>@{c.creatorHandle}</span>
                <span className="font-mono text-xs">{c.usage}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Trending categories</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            {s.trendingCategories.map((c: any, i: number) => (
              <li key={c.category} className="flex justify-between">
                <span><span className="text-muted-foreground mr-2">{i + 1}.</span>{c.category}</span>
                <span className="font-mono text-xs">{c.installs}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function ModerationTab() {
  const queueQ = useListModerationQueue();
  const abuseQ = useListAbuseReports({ status: "open" });
  const approve = useApproveModerationItem();
  const reject = useRejectModerationItem();
  const resolve = useResolveAbuseReport();
  const queue = (((queueQ.data?.data as any)?.items ?? []) as any[]);
  const abuse = (((abuseQ.data?.data as any)?.items ?? []) as any[]);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Skill moderation queue ({queue.length})</CardTitle></CardHeader>
        <CardContent>
          {queue.length === 0 ? (
            <div className="text-sm text-muted-foreground">No submissions awaiting review.</div>
          ) : (
            <div className="space-y-3">
              {queue.map((item) => (
                <div key={item.id} className="rounded-md border border-border/50 p-3" data-testid={`mod-item-${item.id}`}>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-muted-foreground">{item.category} · {new Date(item.updatedAt).toLocaleString()}</div>
                      <p className="mt-1 text-sm">{item.description}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => approve.mutate({ id: item.id, data: { notes: "OK" } })}>Approve</Button>
                      <Button size="sm" variant="destructive" onClick={() => {
                        const reason = window.prompt("Rejection reason?", "Insufficient detail");
                        if (reason) reject.mutate({ id: item.id, data: { reason } });
                      }}>Reject</Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Open abuse reports ({abuse.length})</CardTitle></CardHeader>
        <CardContent>
          {abuse.length === 0 ? (
            <div className="text-sm text-muted-foreground">No open abuse reports.</div>
          ) : (
            <div className="space-y-3">
              {abuse.map((r) => (
                <div key={r.id} className="rounded-md border border-border/50 p-3" data-testid={`abuse-${r.id}`}>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-yellow-500" />
                        {r.targetType}: {r.targetLabel || r.targetId}
                        <Badge variant="outline">{r.severity}</Badge>
                      </div>
                      <p className="mt-1 text-sm">{r.reason}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => resolve.mutate({ id: r.id, data: { status: "resolved" } })}>Resolve</Button>
                      <Button size="sm" variant="outline" onClick={() => resolve.mutate({ id: r.id, data: { status: "dismissed" } })}>Dismiss</Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FlagsTab() {
  const { data, refetch } = useListFeatureFlags();
  const upsert = useSetFeatureFlag();
  const [newKey, setNewKey] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const flags = data?.data.items ?? [];
  return (
    <Card>
      <CardHeader><CardTitle>Feature flags</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-3">
          {flags.map((f) => (
            <div key={f.id} className="flex items-center justify-between rounded-md border border-border/50 p-3" data-testid={`flag-${f.flagKey}`}>
              <div>
                <div className="font-medium">{f.flagKey} <Badge variant="outline">{f.segment}</Badge></div>
                <div className="text-xs text-muted-foreground">{f.description || "—"} · rollout {f.rolloutPercent}%</div>
              </div>
              <Switch
                checked={f.enabled}
                onCheckedChange={(checked) =>
                  upsert.mutate(
                    { key: f.flagKey, data: { enabled: checked, segment: f.segment, description: f.description, rolloutPercent: f.rolloutPercent } },
                    { onSuccess: () => refetch() },
                  )
                }
              />
            </div>
          ))}
          {flags.length === 0 ? <div className="text-sm text-muted-foreground">No flags defined.</div> : null}
        </div>
        <div className="mt-6 space-y-2 border-t border-border/50 pt-4">
          <h4 className="text-sm font-medium">Create a new flag</h4>
          <div className="flex gap-2">
            <Input placeholder="flag_key" value={newKey} onChange={(e) => setNewKey(e.target.value)} data-testid="new-flag-key" />
            <Input placeholder="Description" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            <Button
              onClick={() => {
                if (!newKey) return;
                upsert.mutate(
                  { key: newKey, data: { enabled: false, description: newDesc, rolloutPercent: 100, segment: "all" } },
                  { onSuccess: () => { setNewKey(""); setNewDesc(""); refetch(); } },
                );
              }}
            >Add</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ReleasesTab() {
  const { data, refetch } = useListAppVersions();
  const publish = usePublishAppVersion();
  const [versionString, setVersionString] = useState("");
  const [channel, setChannel] = useState("stable");
  const [notes, setNotes] = useState("");
  const [isCurrent, setIsCurrent] = useState(true);
  const [isMinRequired, setIsMinRequired] = useState(false);
  const items = data?.data.items ?? [];
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Publish a new release</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <Label htmlFor="version">Version string</Label>
              <Input id="version" placeholder="1.2.0" value={versionString} onChange={(e) => setVersionString(e.target.value)} data-testid="version-string" />
            </div>
            <div>
              <Label htmlFor="channel">Channel</Label>
              <Input id="channel" value={channel} onChange={(e) => setChannel(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2 pt-6">
              <label className="flex items-center gap-2 text-sm"><Switch checked={isCurrent} onCheckedChange={setIsCurrent} /> Mark as current</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={isMinRequired} onCheckedChange={setIsMinRequired} /> Force-update floor</label>
            </div>
          </div>
          <div className="mt-3">
            <Label htmlFor="notes">Release notes</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
          <div className="mt-3">
            <Button
              disabled={!versionString}
              onClick={() => {
                publish.mutate(
                  { data: { versionString, channel, notes, isCurrent, isMinRequired } },
                  { onSuccess: () => { setVersionString(""); setNotes(""); refetch(); } },
                );
              }}
              data-testid="publish-version"
            ><Rocket className="mr-2 h-4 w-4" /> Publish</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Recent releases</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr><th className="py-2">Version</th><th>Channel</th><th>Status</th><th>Released</th></tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <tr key={v.id} className="border-t border-border/50">
                  <td className="py-2 font-mono">{v.versionString}</td>
                  <td>{v.channel}</td>
                  <td>
                    {v.isCurrent ? <Badge>Current</Badge> : null}
                    {v.isMinRequired ? <Badge variant="destructive" className="ml-1">Forced</Badge> : null}
                  </td>
                  <td className="text-muted-foreground">{new Date(v.releasedAt).toLocaleString()}</td>
                </tr>
              ))}
              {items.length === 0 ? <tr><td colSpan={4} className="py-4 text-center text-muted-foreground">No releases published yet</td></tr> : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SuperAdminPage() {
  return (
    <div className="container mx-auto max-w-6xl p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold">Super Admin</h1>
        <p className="text-muted-foreground">Platform-wide controls for the OP core team. All actions are recorded in the audit chain.</p>
      </div>
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview"><TrendingUp className="mr-1 h-4 w-4" /> Overview</TabsTrigger>
          <TabsTrigger value="revenue"><DollarSign className="mr-1 h-4 w-4" /> Revenue</TabsTrigger>
          <TabsTrigger value="skills"><Sparkles className="mr-1 h-4 w-4" /> Skills</TabsTrigger>
          <TabsTrigger value="moderation"><ShieldAlert className="mr-1 h-4 w-4" /> Moderation</TabsTrigger>
          <TabsTrigger value="flags"><Flag className="mr-1 h-4 w-4" /> Flags</TabsTrigger>
          <TabsTrigger value="releases"><Rocket className="mr-1 h-4 w-4" /> Releases</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-6"><OverviewTab /></TabsContent>
        <TabsContent value="revenue" className="mt-6"><RevenueTab /></TabsContent>
        <TabsContent value="skills" className="mt-6"><SkillsTab /></TabsContent>
        <TabsContent value="moderation" className="mt-6"><ModerationTab /></TabsContent>
        <TabsContent value="flags" className="mt-6"><FlagsTab /></TabsContent>
        <TabsContent value="releases" className="mt-6"><ReleasesTab /></TabsContent>
      </Tabs>
    </div>
  );
}
