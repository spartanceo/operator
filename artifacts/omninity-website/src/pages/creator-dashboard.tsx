import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Loader2,
  Rocket,
  Sparkles,
  Layers,
  Download,
} from "lucide-react";

import {
  useGetStoreCreatorDashboard,
} from "@workspace/api-client-react";
type StoreCreatorDashboardPayload = any;

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";

export default function CreatorDashboardPage() {
  const [token, setToken] = useState(() => localStorage.getItem("omninity:creator-token") ?? "");
  const [data, setData] = useState<StoreCreatorDashboardPayload | null>(null);
  const dashboard = useGetStoreCreatorDashboard();

  useEffect(() => {
    if (token && !data) {
      void load(token);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(t: string) {
    const res = await dashboard.mutateAsync({ data: { apiToken: t } });
    setData(res.data);
    localStorage.setItem("omninity:creator-token", t);
  }

  return (
    <>
      <SEO
        title="Creator dashboard"
        description="Manage the skills you've published to the Omninity Skill Store."
      />
      <section className="border-b border-border/40 py-10 md:py-14">
        <div className="mx-auto max-w-5xl px-5 md:px-8">
          <Link href="/creators" className="text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 inline h-3.5 w-3.5" /> Back to creators
          </Link>
          <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight">
            Creator dashboard
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in with your creator API token to see your published skills.
          </p>
        </div>
      </section>
      <section className="py-10">
        <div className="mx-auto grid max-w-5xl gap-6 px-5 md:px-8">
          <Card className="p-5">
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <div className="grid gap-2">
                <Label htmlFor="token">Creator API token</Label>
                <Input
                  id="token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="cr_…"
                  data-testid="input-dashboard-token"
                />
              </div>
              <Button
                onClick={() => load(token)}
                disabled={!token.trim() || dashboard.isPending}
                data-testid="button-dashboard-load"
              >
                {dashboard.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Load dashboard
              </Button>
            </div>
            {dashboard.error ? (
              <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                Couldn't load dashboard. Check the token.
              </div>
            ) : null}
          </Card>

          {data ? (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Card className="p-5">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Handle
                  </div>
                  <div className="mt-2 font-mono text-lg font-medium" data-testid="text-dashboard-handle">
                    {data.account.handle}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {data.account.displayName}
                  </div>
                </Card>
                <Card className="p-5">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Total installs
                  </div>
                  <div className="mt-2 text-3xl font-semibold tabular-nums">
                    {data.totalInstalls.toLocaleString()}
                  </div>
                </Card>
                <Card className="p-5">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Versions published
                  </div>
                  <div className="mt-2 text-3xl font-semibold tabular-nums">
                    {data.totalVersions.toLocaleString()}
                  </div>
                </Card>
              </div>

              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium tracking-tight">Your published skills</h2>
                <Link href="/marketplace/create">
                  <Button size="sm" data-testid="button-create-new-skill">
                    <Rocket className="mr-2 h-4 w-4" /> Create another
                  </Button>
                </Link>
              </div>

              {data.publishedSkills.length === 0 ? (
                <Card className="p-8 text-center text-sm text-muted-foreground">
                  Nothing published yet. Build a skill in the wizard and use this token to push it live.
                </Card>
              ) : (
                <div className="grid grid-cols-1 gap-4">
                  {data.publishedSkills.map((s: any) => (
                    <Card key={s.id} className="p-5" data-testid={`dashboard-skill-${s.slug}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 font-medium">
                            {s.name}
                            <Badge
                              variant="outline"
                              className="rounded-full border-primary/30 px-2 py-0 text-[9px] uppercase tracking-wider text-primary"
                            >
                              <Layers className="mr-1 h-2.5 w-2.5" /> v{s.skillVersion}
                            </Badge>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {s.description}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Download className="h-3.5 w-3.5" />
                          {s.installCount.toLocaleString()}
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between">
                        <Badge variant="outline" className="rounded-full text-[10px] uppercase tracking-wider">
                          {s.category}
                        </Badge>
                        <Link
                          href={`/marketplace/${s.creatorHandle}-${s.slug}`}
                          className="text-xs text-primary hover:underline"
                        >
                          View on store →
                        </Link>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      </section>
    </>
  );
}
