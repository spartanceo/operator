import { useMemo, useState } from "react";
import {
  useGetSubscriptionStatus,
  useCreateSubscriptionCheckout,
  useConfirmSubscriptionCheckout,
  useCancelSubscription,
  useReactivateSubscription,
  useGetSubscriptionUsage,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { OperatorSidebar } from "@/components/operator/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, CreditCard } from "lucide-react";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function SubscriptionPage() {
  const status = useGetSubscriptionStatus();
  const usage = useGetSubscriptionUsage();
  const checkout = useCreateSubscriptionCheckout();
  const confirm = useConfirmSubscriptionCheckout();
  const cancel = useCancelSubscription();
  const reactivate = useReactivateSubscription();
  const qc = useQueryClient();
  const [pendingSession, setPendingSession] = useState<string | null>(null);

  const data = status.data?.data as any;
  const usageData = usage.data?.data as any;
  const sub = data?.subscription;
  const isStub = data?.stripeStubMode ?? true;

  const refetchAll = useMemo(
    () => () => {
      void qc.invalidateQueries();
    },
    [qc],
  );

  const handleSubscribe = async () => {
    const res = await checkout.mutateAsync({ data: {} });
    const resData = res.data as any;
    setPendingSession(resData.sessionId);
    if (isStub) {
      await confirm.mutateAsync({ data: { sessionId: resData.sessionId } });
      setPendingSession(null);
      refetchAll();
    } else if (resData.checkoutUrl) {
      window.location.href = resData.checkoutUrl;
    }
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <OperatorSidebar />
      <main className="flex-1 px-8 py-10" data-testid="page-subscription">
        <header className="mb-8 flex items-center gap-3">
          <CreditCard className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold">Subscription</h1>
            <p className="text-sm text-muted-foreground">
              Creator Pro unlocks every premium skill in the marketplace.
            </p>
          </div>
        </header>

        {status.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : sub ? (
          <Card data-testid="card-subscription-status">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Creator Pro · {formatCents(sub.priceCents)}/mo</CardTitle>
              <Badge variant={data?.hasAccess ? "default" : "secondary"} data-testid="badge-status">
                {sub.status}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div>
                <span className="text-muted-foreground">Renews: </span>
                {sub.currentPeriodEnd
                  ? new Date(sub.currentPeriodEnd).toLocaleDateString()
                  : "—"}
                {sub.cancelAtPeriodEnd ? (
                  <span className="ml-2 text-amber-500">(cancels at period end)</span>
                ) : null}
              </div>
              {isStub ? (
                <p className="text-xs text-muted-foreground">
                  Stripe is in offline-stub mode — checkout activates locally.
                </p>
              ) : null}
              <div className="flex gap-2">
                {!data?.hasAccess ? (
                  <Button
                    onClick={handleSubscribe}
                    disabled={checkout.isPending || confirm.isPending}
                    data-testid="button-subscribe"
                  >
                    {checkout.isPending || confirm.isPending ? "Working…" : "Subscribe"}
                  </Button>
                ) : sub.cancelAtPeriodEnd ? (
                  <Button
                    onClick={async () => {
                      await reactivate.mutateAsync();
                      refetchAll();
                    }}
                    data-testid="button-reactivate"
                  >
                    Reactivate
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={async () => {
                      await cancel.mutateAsync();
                      refetchAll();
                    }}
                    data-testid="button-cancel"
                  >
                    Cancel at period end
                  </Button>
                )}
              </div>
              {pendingSession ? (
                <p className="text-xs text-muted-foreground">Session: {pendingSession}</p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <Card className="mt-8" data-testid="card-subscription-usage">
          <CardHeader>
            <CardTitle>Premium skill usage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex gap-6">
              <div>
                <div className="text-2xl font-semibold" data-testid="usage-month">
                  {(usageData as any)?.totalThisMonth ?? 0}
                </div>
                <div className="text-xs text-muted-foreground">this month</div>
              </div>
              <div>
                <div className="text-2xl font-semibold" data-testid="usage-total">
                  {(usageData as any)?.totalAllTime ?? 0}
                </div>
                <div className="text-xs text-muted-foreground">all time</div>
              </div>
            </div>
            {(usageData as any)?.perSkill?.length ? (
              <ul className="divide-y rounded border">
                {(usageData as any).perSkill.map((s: any) => (
                  <li
                    key={s.skillId}
                    className="flex justify-between px-3 py-2"
                    data-testid={`usage-skill-${s.skillSlug}`}
                  >
                    <span>{s.skillSlug}</span>
                    <span className="font-mono">{s.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No premium skill usage yet.</p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
