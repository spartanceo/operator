import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  Plug,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  useListIntegrationProviders,
  useListIntegrations,
  useConnectIntegration,
  useDisconnectIntegration,
  useTestIntegration,
} from "@workspace/api-client-react";
import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorBanner } from "@/components/operator/error-banner";

interface ProviderField {
  name: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
}

interface Provider {
  id: string;
  label: string;
  category: string;
  authType: "oauth" | "api_key";
  description: string;
  oauthScopes: string[];
  fields: ProviderField[];
  actions: { name: string; description: string; riskLevel: string }[];
}

interface Integration {
  id: string;
  provider: string;
  displayName: string;
  authType: string;
  connectionStatus: "disconnected" | "connected" | "error";
  accountLabel: string | null;
  credentials: Record<string, unknown>;
  lastTestedAt: string | null;
  lastError: string | null;
}

function StatusBadge({ status }: { status: Integration["connectionStatus"] }) {
  if (status === "connected") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
        data-testid={`status-connected`}
      >
        <CheckCircle2 className="h-3 w-3" />
        Connected
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-destructive/40 text-destructive"
        data-testid={`status-error`}
      >
        <XCircle className="h-3 w-3" />
        Error
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground" data-testid={`status-disconnected`}>
      <Circle className="h-3 w-3" />
      Not connected
    </Badge>
  );
}

export default function IntegrationsPage() {
  const qc = useQueryClient();
  const providersQuery = useListIntegrationProviders();
  const integrationsQuery = useListIntegrations({ limit: 100 });

  const providers: Provider[] = useMemo(
    () => (providersQuery.data?.data.providers as Provider[] | undefined) ?? [],
    [providersQuery.data],
  );
  const integrations: Integration[] = useMemo(
    () =>
      (integrationsQuery.data?.data.items as Integration[] | undefined) ?? [],
    [integrationsQuery.data],
  );
  const byProvider = useMemo(() => {
    const map = new Map<string, Integration>();
    for (const it of integrations) map.set(it.provider, it);
    return map;
  }, [integrations]);

  const [selected, setSelected] = useState<Provider | null>(null);
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [accountLabel, setAccountLabel] = useState("");

  const connect = useConnectIntegration({
    mutation: {
      onSuccess: () => {
        setSelected(null);
        setCredValues({});
        setAccountLabel("");
        void qc.invalidateQueries();
      },
    },
  });
  const disconnect = useDisconnectIntegration({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });
  const test = useTestIntegration({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const openConnect = (provider: Provider) => {
    setSelected(provider);
    setCredValues({});
    setAccountLabel("");
  };

  const submitConnect = () => {
    if (!selected) return;
    connect.mutate({
      provider: selected.id,
      data: {
        credentials: credValues,
        ...(accountLabel.trim() ? { accountLabel: accountLabel.trim() } : {}),
      },
    });
  };

  const grouped = useMemo(() => {
    const out = new Map<string, Provider[]>();
    for (const p of providers) {
      const list = out.get(p.category) ?? [];
      list.push(p);
      out.set(p.category, list);
    }
    return Array.from(out.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [providers]);

  return (
    <OperatorLayout
      title="Integrations"
      description="Connect Omninity to the platforms your agents need to act on."
    >
      <div className="space-y-6 p-6">
        <ErrorBanner error={providersQuery.error} />
        <ErrorBanner error={integrationsQuery.error} />
        <ErrorBanner error={connect.error} title="Connect failed" />
        <ErrorBanner error={disconnect.error} title="Disconnect failed" />
        <ErrorBanner error={test.error} title="Test failed" />

        {grouped.map(([category, list]) => (
          <section key={category} className="space-y-3">
            <h2
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              data-testid={`category-${category}`}
            >
              {category}
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((provider) => {
                const it = byProvider.get(provider.id);
                const status = it?.connectionStatus ?? "disconnected";
                const isConnected = status === "connected" || status === "error";
                return (
                  <Card
                    key={provider.id}
                    data-testid={`integration-card-${provider.id}`}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <CardTitle className="flex items-center gap-2 text-sm">
                            <Plug className="h-3 w-3 text-muted-foreground" />
                            {provider.label}
                          </CardTitle>
                          <CardDescription className="mt-1 line-clamp-2 text-xs">
                            {provider.description}
                          </CardDescription>
                        </div>
                        <StatusBadge status={status} />
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {provider.authType === "oauth" ? "OAuth" : "API key"}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {provider.actions.length} actions
                        </Badge>
                      </div>
                      {it?.accountLabel ? (
                        <p className="text-xs text-muted-foreground">
                          Account: {it.accountLabel}
                        </p>
                      ) : null}
                      {it?.lastError ? (
                        <p className="text-xs text-destructive">{it.lastError}</p>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={isConnected ? "outline" : "default"}
                          onClick={() => openConnect(provider)}
                          data-testid={`button-connect-${provider.id}`}
                        >
                          {isConnected ? "Reconnect" : "Connect"}
                        </Button>
                        {isConnected ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => test.mutate({ provider: provider.id })}
                              disabled={test.isPending}
                              data-testid={`button-test-${provider.id}`}
                            >
                              <RefreshCw className="mr-1 h-3 w-3" />
                              Test
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                disconnect.mutate({ provider: provider.id })
                              }
                              disabled={disconnect.isPending}
                              data-testid={`button-disconnect-${provider.id}`}
                            >
                              <Trash2 className="mr-1 h-3 w-3" />
                              Disconnect
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        ))}

        <Dialog
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect {selected?.label}</DialogTitle>
              <DialogDescription>
                Credentials are encrypted with AES-256-GCM and stored locally —
                they never leave this device.
              </DialogDescription>
            </DialogHeader>
            {selected ? (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="integration-account-label"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Account label (optional)
                  </label>
                  <Input
                    id="integration-account-label"
                    data-testid="input-integration-account-label"
                    value={accountLabel}
                    onChange={(e) => setAccountLabel(e.target.value)}
                    placeholder="e.g. Personal workspace"
                  />
                </div>
                {selected.fields.map((f) => (
                  <div key={f.name}>
                    <label
                      htmlFor={`integration-field-${f.name}`}
                      className="text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {f.label}
                      {f.required ? " *" : ""}
                    </label>
                    <Input
                      id={`integration-field-${f.name}`}
                      data-testid={`input-integration-field-${f.name}`}
                      type={f.secret ? "password" : "text"}
                      value={credValues[f.name] ?? ""}
                      onChange={(e) =>
                        setCredValues((prev) => ({
                          ...prev,
                          [f.name]: e.target.value,
                        }))
                      }
                      placeholder={f.placeholder}
                    />
                  </div>
                ))}
                <ErrorBanner error={connect.error} />
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelected(null)}>
                Cancel
              </Button>
              <Button
                onClick={submitConnect}
                disabled={connect.isPending}
                data-testid="button-save-integration"
              >
                {connect.isPending ? "Connecting…" : "Connect"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </OperatorLayout>
  );
}
