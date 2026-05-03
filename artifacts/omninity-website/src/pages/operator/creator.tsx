import { useState } from "react";
import { useGetCreatorEarnings } from "@workspace/api-client-react";
import { OperatorSidebar } from "@/components/operator/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Coins } from "lucide-react";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function CreatorRevenuePage() {
  const [token, setToken] = useState("");
  const [submittedToken, setSubmittedToken] = useState<string | null>(null);
  const earnings = useGetCreatorEarnings();
  const data = earnings.data?.data as any;

  const handleLoad = async () => {
    if (!token.trim()) return;
    setSubmittedToken(token.trim());
    await earnings.mutateAsync({ data: { apiToken: token.trim() } });
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <OperatorSidebar />
      <main className="flex-1 px-8 py-10" data-testid="page-creator-revenue">
        <header className="mb-8 flex items-center gap-3">
          <Coins className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold">Creator Revenue</h1>
            <p className="text-sm text-muted-foreground">
              View your share of the Creator Pro pool. Authenticate with your creator API token.
            </p>
          </div>
        </header>

        <Card className="max-w-xl" data-testid="card-creator-auth">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="creator-token">Creator API token</Label>
            <Input
              id="creator-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="cr_…"
              data-testid="input-creator-token"
            />
            <Button
              onClick={handleLoad}
              disabled={!token.trim() || earnings.isPending}
              data-testid="button-load-earnings"
            >
              {earnings.isPending ? "Loading…" : "Load earnings"}
            </Button>
            {earnings.isError ? (
              <p className="text-sm text-destructive" data-testid="error-creator">
                Could not load earnings. Check the token.
              </p>
            ) : null}
          </CardContent>
        </Card>

        {data && submittedToken ? (
          <Card className="mt-8" data-testid="card-creator-earnings">
            <CardHeader>
              <CardTitle>
                {data.creator.displayName} · @{data.creatorHandle}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Estimated earnings" value={formatCents(data.estimatedEarningsCents)} testId="stat-earnings" />
                <Stat label="Your uses" value={String(data.totalUses)} testId="stat-uses" />
                <Stat label="Pool" value={formatCents(data.poolCents)} testId="stat-pool" />
              </div>
              <p className="text-xs text-muted-foreground">
                Period {new Date(data.periodStart).toLocaleDateString()} →{" "}
                {new Date(data.periodEnd).toLocaleDateString()} · global uses {data.globalUses}
              </p>
              {data.perSkill.length ? (
                <ul className="divide-y rounded border">
                  {data.perSkill.map((s: any) => (
                    <li
                      key={s.skillSlug}
                      className="flex justify-between px-3 py-2"
                      data-testid={`earnings-skill-${s.skillSlug}`}
                    >
                      <span>{s.skillSlug}</span>
                      <span className="font-mono">
                        {s.uses} uses · {formatCents(s.earningsCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No premium uses recorded this period.</p>
              )}
            </CardContent>
          </Card>
        ) : null}
      </main>
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div>
      <div className="text-2xl font-semibold" data-testid={testId}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
