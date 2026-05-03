/**
 * Enterprise Admin portal — per-tenant org dashboard.
 *
 * Tabs:
 *   - Branding & SSO
 *   - Seats & roles
 *   - Skill whitelist
 *   - Audit log (with CSV export)
 *   - Usage report (with CSV export)
 *
 * The portal lives inside the existing omninity-website artifact under
 * `/admin/enterprise/*` and reuses the shared design system. The
 * tenant context comes from the user's session via the Tenant header
 * already injected by `initApiClient` (see `lib/api-config.ts`).
 */
import { useEffect, useState } from "react";
import {
  Building2,
  Users,
  ShieldCheck,
  ScrollText,
  BarChart3,
  Loader2,
  Download,
  KeyRound,
  AlertTriangle,
} from "lucide-react";
import {
  useGetEnterpriseOrg,
  useUpdateEnterpriseOrg,
  useListEnterpriseSeats,
  useInviteEnterpriseSeat,
  useUpdateEnterpriseSeat,
  useRemoveEnterpriseSeat,
  useGetEnterpriseWhitelist,
  useSetEnterpriseWhitelistEntry,
  useListEnterpriseAudit,
  useGetEnterpriseUsage,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

function downloadCsv(path: string, filename: string) {
  const a = document.createElement("a");
  a.href = path;
  a.download = filename;
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function BrandingTab() {
  const orgQ = useGetEnterpriseOrg();
  const update = useUpdateEnterpriseOrg();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  if (orgQ.isLoading || !orgQ.data) return <Loader2 className="h-5 w-5 animate-spin" />;
  const org = orgQ.data.data;
  const v = (k: string, fallback: unknown) => (k in draft ? draft[k] : fallback);
  return (
    <Card>
      <CardHeader><CardTitle>Branding & SSO</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="name">Organisation name</Label>
            <Input id="name" value={String(v("name", org.name))} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="org-name" />
          </div>
          <div>
            <Label htmlFor="logo">Logo URL</Label>
            <Input id="logo" value={String(v("logoUrl", org.logoUrl ?? ""))} onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="color">Primary color</Label>
            <Input id="color" type="color" value={String(v("primaryColor", org.primaryColor))} onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="seatLimit">Seat limit</Label>
            <Input id="seatLimit" type="number" value={Number(v("seatLimit", org.seatLimit))} onChange={(e) => setDraft({ ...draft, seatLimit: Number(e.target.value) })} />
          </div>
          <div>
            <Label htmlFor="ssoProvider">SSO provider</Label>
            <Select value={String(v("ssoProvider", org.ssoProvider ?? "none"))} onValueChange={(val) => setDraft({ ...draft, ssoProvider: val === "none" ? null : val })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="google">Google Workspace</SelectItem>
                <SelectItem value="microsoft">Microsoft 365</SelectItem>
                <SelectItem value="okta">Okta</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="ssoDomain">SSO email domain</Label>
            <Input id="ssoDomain" placeholder="acme.com" value={String(v("ssoDomain", org.ssoDomain ?? ""))} onChange={(e) => setDraft({ ...draft, ssoDomain: e.target.value })} />
          </div>
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/50 p-3">
          <div>
            <div className="font-medium">Air-gapped mode</div>
            <div className="text-xs text-muted-foreground">Disable all telemetry, store sync, and cloud auth. Devices run offline-only.</div>
          </div>
          <Switch
            checked={Boolean(v("airGapped", org.airGapped))}
            onCheckedChange={(c) => setDraft({ ...draft, airGapped: c })}
            data-testid="air-gapped-switch"
          />
        </div>
        <Button
          onClick={() => update.mutate({ data: draft }, { onSuccess: () => { setDraft({}); orgQ.refetch(); } })}
          disabled={Object.keys(draft).length === 0}
          data-testid="save-org"
        >Save changes</Button>
      </CardContent>
    </Card>
  );
}

function SeatsTab() {
  const seatsQ = useListEnterpriseSeats();
  const orgQ = useGetEnterpriseOrg();
  const invite = useInviteEnterpriseSeat();
  const updateSeat = useUpdateEnterpriseSeat();
  const removeSeat = useRemoveEnterpriseSeat();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "standard" | "readonly">("standard");
  const [error, setError] = useState<string | null>(null);
  const seats = seatsQ.data?.data.items ?? [];
  const org = orgQ.data?.data;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Invite a teammate</CardTitle>
          {org ? <div className="text-xs text-muted-foreground">{seats.length} of {org.seatLimit} seats used</div> : null}
        </CardHeader>
        <CardContent>
          {error ? <div className="mb-3 rounded-md border border-destructive bg-destructive/10 p-2 text-sm text-destructive">{error}</div> : null}
          <div className="grid gap-3 md:grid-cols-4">
            <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="invite-email" />
            <Input placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
              <SelectTrigger data-testid="invite-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="readonly">Read-only</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                setError(null);
                invite.mutate(
                  { data: { email, displayName: name, role } },
                  {
                    onSuccess: () => { setEmail(""); setName(""); seatsQ.refetch(); },
                    onError: (e: unknown) => setError(e instanceof Error ? e.message : "Invite failed"),
                  },
                );
              }}
              disabled={!email}
              data-testid="invite-submit"
            >Invite</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Seats</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr><th className="py-2">Email</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {seats.map((s) => (
                <tr key={s.id} className="border-t border-border/50" data-testid={`seat-${s.id}`}>
                  <td className="py-2">{s.email}</td>
                  <td className="text-muted-foreground">{s.displayName || "—"}</td>
                  <td>
                    <Select value={s.role} onValueChange={(v) => updateSeat.mutate({ id: s.id, data: { role: v } }, { onSuccess: () => seatsQ.refetch() })}>
                      <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="readonly">Read-only</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td><Badge variant={s.status === "active" ? "default" : "secondary"}>{s.status}</Badge></td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => removeSeat.mutate({ id: s.id }, { onSuccess: () => seatsQ.refetch() })}>Remove</Button>
                  </td>
                </tr>
              ))}
              {seats.length === 0 ? <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">No seats yet — invite your first teammate above.</td></tr> : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function WhitelistTab() {
  const wlQ = useGetEnterpriseWhitelist();
  const setEntry = useSetEnterpriseWhitelistEntry();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const items = wlQ.data?.data.items ?? [];
  return (
    <Card>
      <CardHeader><CardTitle>Skill whitelist</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">Only allow-listed skills are installable on this org's devices. Empty list = all skills allowed.</p>
        <div className="space-y-2">
          {items.map((e) => (
            <div key={e.skillSlug} className="flex items-center justify-between rounded-md border border-border/50 p-3" data-testid={`wl-${e.skillSlug}`}>
              <div>
                <div className="font-medium">{e.skillName || e.skillSlug}</div>
                <div className="text-xs text-muted-foreground font-mono">{e.skillSlug}</div>
              </div>
              <Switch
                checked={e.allowed}
                onCheckedChange={(c) => setEntry.mutate({ slug: e.skillSlug, data: { allowed: c, skillName: e.skillName } }, { onSuccess: () => wlQ.refetch() })}
              />
            </div>
          ))}
          {items.length === 0 ? <div className="text-sm text-muted-foreground">No entries — all skills currently allowed.</div> : null}
        </div>
        <div className="mt-6 space-y-2 border-t border-border/50 pt-4">
          <h4 className="text-sm font-medium">Add a skill</h4>
          <div className="flex gap-2">
            <Input placeholder="skill-slug" value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="wl-new-slug" />
            <Input placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button onClick={() => {
              if (!slug) return;
              setEntry.mutate({ slug, data: { allowed: true, skillName: name } }, { onSuccess: () => { setSlug(""); setName(""); wlQ.refetch(); } });
            }}>Allow</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AuditTab() {
  const auditQ = useListEnterpriseAudit();
  const items = auditQ.data?.data.items ?? [];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Audit log</CardTitle>
          <Button variant="outline" size="sm" onClick={() => downloadCsv("/api/admin/enterprise/audit/export.csv", "audit-log.csv")} data-testid="export-audit">
            <Download className="mr-1 h-4 w-4" /> Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr><th className="py-2">Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Summary</th></tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="border-t border-border/50" data-testid={`audit-${e.id}`}>
                <td className="py-2 text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="font-mono text-xs">{e.actor}</td>
                <td><Badge variant="outline">{e.action}</Badge></td>
                <td className="text-xs">{e.resourceType}{e.resourceId ? `/${e.resourceId}` : ""}</td>
                <td>{e.summary}</td>
              </tr>
            ))}
            {items.length === 0 ? <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">No audit entries yet.</td></tr> : null}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function UsageTab() {
  const [days, setDays] = useState(30);
  const usageQ = useGetEnterpriseUsage({ days });
  if (usageQ.isLoading || !usageQ.data) return <Loader2 className="h-5 w-5 animate-spin" />;
  const u = usageQ.data.data;
  const max = Math.max(1, ...u.perDay.map((d) => d.runs));
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Label htmlFor="days">Range (days):</Label>
        <Input id="days" type="number" className="w-24" value={days} onChange={(e) => setDays(Number(e.target.value) || 30)} />
        <Button variant="outline" size="sm" onClick={() => downloadCsv(`/api/admin/enterprise/usage/export.csv?days=${days}`, "usage.csv")} data-testid="export-usage">
          <Download className="mr-1 h-4 w-4" /> Export CSV
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Tasks automated</CardTitle></CardHeader><CardContent><div className="text-2xl font-semibold">{u.tasksAutomated}</div></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Conversations</CardTitle></CardHeader><CardContent><div className="text-2xl font-semibold">{u.conversationsStarted}</div></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Time saved</CardTitle></CardHeader><CardContent><div className="text-2xl font-semibold">{Math.round(u.estimatedTimeSavedMinutes / 60)} hrs</div><div className="text-xs text-muted-foreground">@ 7 min/run</div></CardContent></Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Daily activity</CardTitle></CardHeader>
        <CardContent>
          <div className="flex h-32 items-end gap-1">
            {u.perDay.map((p) => (
              <div key={p.date} className="flex-1" title={`${p.date}: ${p.runs}`}>
                <div className="bg-primary/70 rounded-t" style={{ height: `${(p.runs / max) * 100}%`, minHeight: 2 }} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Top skills</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            {u.topSkills.map((s, i) => (
              <li key={s.slug} className="flex justify-between">
                <span><span className="text-muted-foreground mr-2">{i + 1}.</span>{s.name}</span>
                <span className="font-mono text-xs">{s.runs}</span>
              </li>
            ))}
            {u.topSkills.length === 0 ? <li className="text-muted-foreground">No usage yet.</li> : null}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

type SsoConfig = {
  protocol: "saml" | "oidc" | "disabled";
  enabled: boolean;
  jitProvisioningEnabled: boolean;
  defaultRole: string;
  samlIdpEntityId?: string | null;
  samlIdpSsoUrl?: string | null;
  samlIdpCertPem?: string | null;
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  oidcClientSecret?: string | null;
  oidcScopes?: string | null;
};

type SsoLoginEvent = {
  id: string;
  protocol: string;
  outcome: string;
  subject?: string | null;
  email?: string | null;
  errorCode?: string | null;
  createdAt: number;
};

type ScimToken = { id: string; name: string; createdAt: number; lastUsedAt?: number | null; revokedAt?: number | null };
type BreakGlass = { id: string; email: string; lastUsedAt?: number | null; createdAt: number; disabledAt?: number | null };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? res.statusText);
  return body.data as T;
}

function SsoTab() {
  const [cfg, setCfg] = useState<SsoConfig | null>(null);
  const [events, setEvents] = useState<SsoLoginEvent[]>([]);
  const [tokens, setTokens] = useState<ScimToken[]>([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenSecret, setNewTokenSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    try {
      const [c, e, t] = await Promise.all([
        api<SsoConfig>("/admin/enterprise/sso/config"),
        api<{ items: SsoLoginEvent[] }>("/admin/enterprise/sso/login-events?limit=20"),
        api<{ items: ScimToken[] }>("/admin/enterprise/sso/scim-tokens"),
      ]);
      setCfg(c);
      setEvents(e.items ?? []);
      setTokens(t.items ?? []);
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  useEffect(() => { void reload(); }, []);

  async function save() {
    if (!cfg) return;
    setBusy(true); setErr(null);
    try {
      await api("/admin/enterprise/sso/config", { method: "PUT", body: JSON.stringify(cfg) });
      await reload();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  async function mintToken() {
    if (!newTokenName.trim()) return;
    setBusy(true); setErr(null);
    try {
      const out = await api<{ token: string }>("/admin/enterprise/sso/scim-tokens", {
        method: "POST",
        body: JSON.stringify({ name: newTokenName.trim() }),
      });
      setNewTokenSecret(out.token);
      setNewTokenName("");
      await reload();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  async function revokeToken(id: string) {
    setBusy(true); setErr(null);
    try {
      await api(`/admin/enterprise/sso/scim-tokens/${id}`, { method: "DELETE" });
      await reload();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  if (!cfg) return <Loader2 className="h-5 w-5 animate-spin" />;

  return (
    <div className="space-y-6">
      {err ? <div className="text-sm text-red-600">{err}</div> : null}
      <Card>
        <CardHeader><CardTitle>Identity provider</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <Label>Protocol</Label>
              <Select value={cfg.protocol} onValueChange={(v) => setCfg({ ...cfg, protocol: v as SsoConfig["protocol"] })}>
                <SelectTrigger data-testid="sso-protocol"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="disabled">Disabled</SelectItem>
                  <SelectItem value="saml">SAML 2.0</SelectItem>
                  <SelectItem value="oidc">OIDC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch checked={cfg.enabled} onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })} id="sso-enabled" />
              <Label htmlFor="sso-enabled">Enabled</Label>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch checked={cfg.jitProvisioningEnabled} onCheckedChange={(v) => setCfg({ ...cfg, jitProvisioningEnabled: v })} id="sso-jit" />
              <Label htmlFor="sso-jit">JIT provisioning</Label>
            </div>
          </div>

          {cfg.protocol === "saml" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>IdP entity ID</Label><Input value={cfg.samlIdpEntityId ?? ""} onChange={(e) => setCfg({ ...cfg, samlIdpEntityId: e.target.value })} /></div>
              <div><Label>IdP SSO URL</Label><Input value={cfg.samlIdpSsoUrl ?? ""} onChange={(e) => setCfg({ ...cfg, samlIdpSsoUrl: e.target.value })} /></div>
              <div className="md:col-span-2"><Label>IdP signing certificate (PEM)</Label>
                <textarea className="w-full rounded border p-2 font-mono text-xs" rows={6} value={cfg.samlIdpCertPem ?? ""} onChange={(e) => setCfg({ ...cfg, samlIdpCertPem: e.target.value })} />
              </div>
              <div className="text-xs text-muted-foreground md:col-span-2">
                SP metadata: <a className="underline" href="/api/sso/saml/metadata">/api/sso/saml/metadata</a>
              </div>
            </div>
          ) : null}

          {cfg.protocol === "oidc" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>Issuer URL</Label><Input value={cfg.oidcIssuer ?? ""} onChange={(e) => setCfg({ ...cfg, oidcIssuer: e.target.value })} /></div>
              <div><Label>Client ID</Label><Input value={cfg.oidcClientId ?? ""} onChange={(e) => setCfg({ ...cfg, oidcClientId: e.target.value })} /></div>
              <div><Label>Client secret</Label><Input type="password" value={cfg.oidcClientSecret ?? ""} onChange={(e) => setCfg({ ...cfg, oidcClientSecret: e.target.value })} /></div>
              <div><Label>Scopes</Label><Input value={cfg.oidcScopes ?? "openid profile email"} onChange={(e) => setCfg({ ...cfg, oidcScopes: e.target.value })} /></div>
            </div>
          ) : null}

          <div>
            <Label>Default role for new users</Label>
            <Input value={cfg.defaultRole} onChange={(e) => setCfg({ ...cfg, defaultRole: e.target.value })} className="max-w-xs" />
          </div>

          <Button onClick={save} disabled={busy} data-testid="save-sso">Save</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>SCIM provisioning tokens</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input placeholder="Token name (e.g. Okta)" value={newTokenName} onChange={(e) => setNewTokenName(e.target.value)} data-testid="scim-token-name" />
            <Button onClick={mintToken} disabled={busy || !newTokenName.trim()}>Generate</Button>
          </div>
          {newTokenSecret ? (
            <div className="rounded border bg-amber-50 p-3 text-xs">
              <div className="font-semibold text-amber-900">Copy this token now — it won't be shown again:</div>
              <code className="mt-1 block break-all">{newTokenSecret}</code>
              <Button variant="ghost" size="sm" className="mt-1" onClick={() => setNewTokenSecret(null)}>Dismiss</Button>
            </div>
          ) : null}
          <table className="w-full text-sm">
            <thead><tr className="text-muted-foreground"><th className="text-left">Name</th><th className="text-left">Created</th><th className="text-left">Last used</th><th /></tr></thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="py-1">{t.name}{t.revokedAt ? <Badge variant="secondary" className="ml-2">revoked</Badge> : null}</td>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                  <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "—"}</td>
                  <td>{!t.revokedAt ? <Button size="sm" variant="ghost" onClick={() => revokeToken(t.id)}>Revoke</Button> : null}</td>
                </tr>
              ))}
              {tokens.length === 0 ? <tr><td colSpan={4} className="text-muted-foreground py-2">No tokens yet.</td></tr> : null}
            </tbody>
          </table>
          <div className="text-xs text-muted-foreground">SCIM endpoint: <code>/api/scim/v2/Users</code>, <code>/api/scim/v2/Groups</code></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent SSO login events</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead><tr className="text-muted-foreground"><th className="text-left">When</th><th className="text-left">Protocol</th><th className="text-left">Outcome</th><th className="text-left">Subject</th><th className="text-left">Error</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="py-1">{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{e.protocol}</td>
                  <td><Badge variant={e.outcome === "success" ? "default" : "destructive"}>{e.outcome}</Badge></td>
                  <td className="font-mono text-xs">{e.email ?? e.subject ?? "—"}</td>
                  <td className="text-xs text-red-600">{e.errorCode ?? ""}</td>
                </tr>
              ))}
              {events.length === 0 ? <tr><td colSpan={5} className="text-muted-foreground py-2">No SSO logins yet.</td></tr> : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function BreakGlassBanner() {
  const [accounts, setAccounts] = useState<BreakGlass[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState("");
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    try {
      const r = await api<{ items: BreakGlass[] }>("/admin/enterprise/break-glass");
      setAccounts(r.items ?? []);
    } catch (x) { setErr((x as Error).message); }
  }
  useEffect(() => { void reload(); }, []);

  async function create() {
    setErr(null);
    try {
      const out = await api<{ email: string; password: string }>("/admin/enterprise/break-glass", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setIssued(out);
      setEmail("");
      setCreating(false);
      await reload();
    } catch (x) { setErr((x as Error).message); }
  }

  if (accounts === null) return null;
  const active = accounts.filter((a) => !a.disabledAt);
  if (active.length > 0 && !creating && !issued) return null;

  return (
    <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-700" />
        <div className="flex-1">
          {active.length === 0 ? (
            <>
              <div className="font-semibold text-amber-900">No break-glass account configured</div>
              <div className="text-xs text-amber-800">If your IdP fails, you'll be locked out. Create an emergency local-admin login now.</div>
            </>
          ) : (
            <div className="font-semibold text-amber-900">Break-glass account active — keep credentials in your password vault.</div>
          )}
          {err ? <div className="text-xs text-red-700">{err}</div> : null}
          {issued ? (
            <div className="mt-2 rounded border bg-white p-2 text-xs">
              <div className="font-semibold">Save these credentials — the password is shown only once:</div>
              <div>Email: <code>{issued.email}</code></div>
              <div>Password: <code>{issued.password}</code></div>
              <Button size="sm" variant="ghost" className="mt-1" onClick={() => setIssued(null)}>Dismiss</Button>
            </div>
          ) : creating ? (
            <div className="mt-2 flex gap-2">
              <Input placeholder="admin@yourco.com" value={email} onChange={(e) => setEmail(e.target.value)} className="max-w-xs" />
              <Button size="sm" onClick={create}><KeyRound className="mr-1 h-3 w-3" /> Generate</Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          ) : active.length === 0 ? (
            <Button size="sm" className="mt-2" onClick={() => setCreating(true)} data-testid="create-break-glass">
              <KeyRound className="mr-1 h-3 w-3" /> Create break-glass account
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function EnterpriseAdminPage() {
  return (
    <div className="container mx-auto max-w-6xl p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold">Enterprise Admin</h1>
        <p className="text-muted-foreground">Manage your organisation's branding, seats, allow-listed skills, audit log and usage. All actions are recorded.</p>
      </div>
      <BreakGlassBanner />
      <Tabs defaultValue="branding">
        <TabsList>
          <TabsTrigger value="branding"><Building2 className="mr-1 h-4 w-4" /> Branding</TabsTrigger>
          <TabsTrigger value="sso"><KeyRound className="mr-1 h-4 w-4" /> SSO &amp; SCIM</TabsTrigger>
          <TabsTrigger value="seats"><Users className="mr-1 h-4 w-4" /> Seats</TabsTrigger>
          <TabsTrigger value="whitelist"><ShieldCheck className="mr-1 h-4 w-4" /> Whitelist</TabsTrigger>
          <TabsTrigger value="audit"><ScrollText className="mr-1 h-4 w-4" /> Audit log</TabsTrigger>
          <TabsTrigger value="usage"><BarChart3 className="mr-1 h-4 w-4" /> Usage</TabsTrigger>
        </TabsList>
        <TabsContent value="branding" className="mt-6"><BrandingTab /></TabsContent>
        <TabsContent value="sso" className="mt-6"><SsoTab /></TabsContent>
        <TabsContent value="seats" className="mt-6"><SeatsTab /></TabsContent>
        <TabsContent value="whitelist" className="mt-6"><WhitelistTab /></TabsContent>
        <TabsContent value="audit" className="mt-6"><AuditTab /></TabsContent>
        <TabsContent value="usage" className="mt-6"><UsageTab /></TabsContent>
      </Tabs>
    </div>
  );
}
