/**
 * /mobile — Mobile Companion PWA dashboard.
 *
 * This page is the entry point users land on after scanning the desktop
 * pairing QR. It is touch-optimised, dark-mode-only, and renders four
 * stacked sections: live status, pending approvals, recent activity,
 * and a quick-task composer.
 *
 * Pairing state lives in localStorage under `omninity.mobile.pairing`.
 * Until the user has paired, the page renders a "Pair this device"
 * landing flow that accepts a manually-typed pairing code (the QR scan
 * delivers users here with a hash-encoded payload that is parsed and
 * auto-submitted).
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Loader2,
  Send,
  ShieldCheck,
  Smartphone,
  WifiOff,
  X,
} from "lucide-react";
import {
  ApprovalDecisionRequestDecision,
  useClaimMobilePairing,
  useCreateMobileQuickTask,
  useDecideApproval,
  useGetMobileStatus,
  useHeartbeatMobileDevice,
  useListMobileActivity,
  useListMobileApprovals,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Wordmark } from "@/components/brand/wordmark";
import { canInstallPwa, detectPlatform, initPwa, onInstallAvailable, promptInstallPwa } from "@/lib/pwa";
import {
  setTenantId as setApiTenantId,
  setWorkspaceId as setApiWorkspaceId,
} from "@/lib/api-config";

const PAIRING_STORAGE_KEY = "omninity.mobile.pairing";

interface PairingState {
  deviceId: string;
  relayToken: string;
  label: string;
  tenantId?: string;
  workspaceId?: string;
}

interface QrPayload {
  v?: number;
  code: string;
  token: string;
  tenantId?: string;
  workspaceId?: string;
  expiresAt?: number;
}

function readPairing(): PairingState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PAIRING_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PairingState;
  } catch {
    return null;
  }
}

function writePairing(p: PairingState | null) {
  if (typeof window === "undefined") return;
  if (p === null) {
    window.localStorage.removeItem(PAIRING_STORAGE_KEY);
  } else {
    window.localStorage.setItem(PAIRING_STORAGE_KEY, JSON.stringify(p));
  }
}

function parsePairingFromUrl(): QrPayload | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith("pair=")) return null;
  try {
    const payload = decodeURIComponent(hash.slice("pair=".length));
    const parsed = JSON.parse(atob(payload)) as QrPayload;
    if (parsed && typeof parsed.code === "string" && typeof parsed.token === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export default function MobilePage() {
  useEffect(() => {
    initPwa("/sw.js");
    document.documentElement.classList.add("dark");
    document.documentElement.dataset.theme = "dark";
  }, []);

  const [pairing, setPairing] = useState<PairingState | null>(() => readPairing());
  const [qrPayload, setQrPayload] = useState<QrPayload | null>(() => parsePairingFromUrl());

  // If a pairing payload is in the URL hash and we're not yet paired,
  // surface the auto-claim form prefilled.
  useEffect(() => {
    if (!pairing && qrPayload) {
      // No-op — the PairingFlow component reads qrPayload directly.
    }
  }, [pairing, qrPayload]);

  if (!pairing) {
    return (
      <PairingFlow
        prefilled={qrPayload}
        onClaimed={(state) => {
          writePairing(state);
          if (state.tenantId) setApiTenantId(state.tenantId);
          if (state.workspaceId) setApiWorkspaceId(state.workspaceId);
          setPairing(state);
          setQrPayload(null);
          if (typeof window !== "undefined" && window.location.hash) {
            window.history.replaceState(null, "", window.location.pathname);
          }
        }}
      />
    );
  }

  return (
    <PairedDashboard
      pairing={pairing}
      onUnpair={() => {
        writePairing(null);
        setPairing(null);
      }}
    />
  );
}

function PairingFlow({
  prefilled,
  onClaimed,
}: {
  prefilled: QrPayload | null;
  onClaimed: (state: PairingState) => void;
}) {
  const [code, setCode] = useState(prefilled?.code ?? "");
  const [relayToken, setRelayToken] = useState(prefilled?.token ?? "");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installAvailable, setInstallAvailable] = useState(false);
  useEffect(() => onInstallAvailable(setInstallAvailable), []);

  // If we have the tenant info from the QR payload, push it to the API
  // client BEFORE we make the claim call so the request hits the right
  // tenant scope.
  useEffect(() => {
    if (prefilled?.tenantId) setApiTenantId(prefilled.tenantId);
    if (prefilled?.workspaceId) setApiWorkspaceId(prefilled.workspaceId);
  }, [prefilled]);

  const claim = useClaimMobilePairing({
    mutation: {
      onSuccess: (resp) => {
        if (!resp.success) return;
        onClaimed({
          deviceId: resp.data.device.id,
          relayToken: resp.data.relayToken,
          label: resp.data.device.label,
          ...(prefilled?.tenantId ? { tenantId: prefilled.tenantId } : {}),
          ...(prefilled?.workspaceId ? { workspaceId: prefilled.workspaceId } : {}),
        });
      },
      onError: (e: Error) => setError(e.message || "Pairing failed"),
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !relayToken.trim() || !label.trim()) {
      setError("Code, token, and label are required");
      return;
    }
    claim.mutate({
      data: {
        code: code.trim(),
        relayToken: relayToken.trim(),
        label: label.trim(),
        platform: detectPlatform(),
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : undefined,
      },
    });
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-md flex-col px-4 pt-10 pb-8">
        <header className="mb-8 flex items-center justify-between">
          <Wordmark size="md" />
          <span className="text-xs text-muted-foreground">Mobile</span>
        </header>

        <Card className="border-border/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Smartphone className="h-5 w-5 text-primary" />
              Pair this phone
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Open Omninity Operator on your desktop, go to{" "}
              <span className="text-foreground">Settings → Remote Access</span>, and scan the QR
              code with this phone. Or type the 8-digit pairing code below.
            </p>
            <form onSubmit={onSubmit} className="space-y-3">
              <div>
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Pairing code
                </label>
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="00000000"
                  data-testid="input-pair-code"
                  className="text-center text-2xl tracking-widest"
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Relay token
                </label>
                <Input
                  value={relayToken}
                  onChange={(e) => setRelayToken(e.target.value)}
                  placeholder="mrt_..."
                  data-testid="input-pair-token"
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Device label
                </label>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Sam's iPhone"
                  data-testid="input-pair-label"
                />
              </div>
              {error ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  {error}
                </div>
              ) : null}
              <Button
                type="submit"
                className="w-full"
                disabled={claim.isPending}
                data-testid="button-pair-submit"
              >
                {claim.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-2 h-4 w-4" />
                )}
                Pair securely
              </Button>
            </form>
          </CardContent>
        </Card>

        {installAvailable ? (
          <Card className="mt-4 border-primary/40 bg-primary/5">
            <CardContent className="flex items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm font-medium">Add to Home Screen</p>
                <p className="text-xs text-muted-foreground">
                  Install OP Mobile to get push notifications and open it like a native app.
                </p>
              </div>
              <Button size="sm" onClick={() => void promptInstallPwa()} data-testid="button-install-pwa">
                Install
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function PairedDashboard({
  pairing,
  onUnpair,
}: {
  pairing: PairingState;
  onUnpair: () => void;
}) {
  const qc = useQueryClient();
  const [composer, setComposer] = useState("");
  const [installAvailable, setInstallAvailable] = useState(canInstallPwa());

  useEffect(() => onInstallAvailable(setInstallAvailable), []);

  // Apply tenant scoping if the QR payload provided it earlier so the
  // PWA's API calls land on the right desktop instance.
  useEffect(() => {
    if (pairing.tenantId) setApiTenantId(pairing.tenantId);
    if (pairing.workspaceId) setApiWorkspaceId(pairing.workspaceId);
  }, [pairing]);

  const status = useGetMobileStatus({
    query: { refetchInterval: 5_000 } as never,
  });
  const approvals = useListMobileApprovals(
    {},
    { query: { refetchInterval: 5_000 } as never },
  );
  const activity = useListMobileActivity(
    { limit: 20 },
    { query: { refetchInterval: 10_000 } as never },
  );

  const heartbeat = useHeartbeatMobileDevice();
  useEffect(() => {
    const beat = () => heartbeat.mutate({ id: pairing.deviceId });
    beat();
    const t = window.setInterval(beat, 30_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing.deviceId]);

  const decide = useDecideApproval({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries();
      },
    },
  });
  const quickTask = useCreateMobileQuickTask({
    mutation: {
      onSuccess: () => {
        setComposer("");
        void qc.invalidateQueries();
      },
    },
  });

  const conn = status.data?.success ? status.data.data.connection : "offline";
  const activeRun = status.data?.success ? status.data.data.activeRun : null;
  const pendingCount = status.data?.success ? status.data.data.pendingApprovalCount : 0;

  const approvalItems = useMemo(
    () => (approvals.data?.success ? approvals.data.data.items : []),
    [approvals.data],
  );
  const activityItems = useMemo(
    () => (activity.data?.success ? activity.data.data : []),
    [activity.data],
  );

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-md px-4 pt-6 pb-24">
        <header className="mb-4 flex items-center justify-between">
          <Wordmark size="sm" />
          <ConnectionPill conn={conn} />
        </header>

        <Card className="border-border/60">
          <CardContent className="space-y-3 py-4">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Now
              </span>
              {pendingCount > 0 ? (
                <Badge variant="default" className="bg-primary text-primary-foreground">
                  {pendingCount} approval{pendingCount === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </div>
            {activeRun ? (
              <div>
                <p className="text-base font-semibold">{activeRun.title}</p>
                <p className="text-xs text-muted-foreground">
                  {activeRun.status} · updated{" "}
                  {new Date(activeRun.updatedAt).toLocaleTimeString()}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                OP is idle. Send a quick task below to get started.
              </p>
            )}
          </CardContent>
        </Card>

        <h2 className="mt-6 mb-2 px-1 text-xs uppercase tracking-wide text-muted-foreground">
          Pending approvals
        </h2>
        <div className="space-y-3">
          {approvalItems.length === 0 ? (
            <Card className="border-border/40">
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                <Check className="mx-auto mb-2 h-5 w-5 text-primary" />
                Nothing waiting on you.
              </CardContent>
            </Card>
          ) : (
            approvalItems.map((a) => (
              <ApprovalCard
                key={a.id}
                item={a}
                pending={decide.isPending}
                onDecide={(decision) =>
                  decide.mutate({
                    id: a.id,
                    data: { decision: decision === "approved" ? ApprovalDecisionRequestDecision.approved : ApprovalDecisionRequestDecision.denied },
                  })
                }
              />
            ))
          )}
        </div>

        <h2 className="mt-6 mb-2 px-1 text-xs uppercase tracking-wide text-muted-foreground">
          Recent activity
        </h2>
        <Card className="border-border/40">
          <CardContent className="divide-y divide-border/40 p-0">
            {activityItems.length === 0 ? (
              <p className="px-4 py-4 text-center text-sm text-muted-foreground">
                No recent activity yet.
              </p>
            ) : (
              activityItems.slice(0, 20).map((it) => (
                <div key={it.id} className="flex items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{it.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {it.status} · {new Date(it.at).toLocaleString()}
                    </p>
                  </div>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <h2 className="mt-6 mb-2 px-1 text-xs uppercase tracking-wide text-muted-foreground">
          Quick task
        </h2>
        <Card className="border-border/40">
          <CardContent className="space-y-2 py-4">
            <Textarea
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              placeholder="Tell OP what to do — it will pick this up next time it polls."
              rows={3}
              data-testid="input-quick-task"
            />
            <Button
              className="w-full"
              disabled={!composer.trim() || quickTask.isPending}
              onClick={() =>
                quickTask.mutate({
                  data: { body: composer.trim(), deviceId: pairing.deviceId },
                })
              }
              data-testid="button-quick-task-send"
            >
              <Send className="mr-2 h-4 w-4" />
              Send to OP
            </Button>
            {quickTask.error ? (
              <p className="text-xs text-destructive">
                {quickTask.error instanceof Error ? quickTask.error.message : "Send failed"}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {installAvailable ? (
          <Card className="mt-6 border-primary/40 bg-primary/5">
            <CardContent className="flex items-center justify-between gap-3 py-4">
              <div className="text-xs text-muted-foreground">
                Add to Home Screen for push notifications.
              </div>
              <Button size="sm" onClick={() => void promptInstallPwa()} data-testid="button-install-pwa">
                Install
              </Button>
            </CardContent>
          </Card>
        ) : null}

        <div className="mt-6 flex items-center justify-between text-xs text-muted-foreground">
          <span>Paired as {pairing.label}</span>
          <button
            onClick={onUnpair}
            data-testid="button-unpair"
            className="underline hover:text-foreground"
          >
            Unpair this device
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionPill({ conn }: { conn: "online" | "idle" | "offline" }) {
  if (conn === "online") {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-400">
        <CircleDot className="h-3 w-3" /> Online
      </span>
    );
  }
  if (conn === "idle") {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-400">
        <CircleDot className="h-3 w-3" /> Idle
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <WifiOff className="h-3 w-3" /> Offline
    </span>
  );
}

interface ApprovalItem {
  id: string;
  reason: string;
  summary: string;
  riskLevel: string;
  createdAt: string;
}

function ApprovalCard({
  item,
  pending,
  onDecide,
}: {
  item: ApprovalItem;
  pending: boolean;
  onDecide: (decision: "approved" | "denied") => void;
}) {
  const riskColor =
    item.riskLevel === "critical" || item.riskLevel === "high"
      ? "text-destructive"
      : item.riskLevel === "medium"
        ? "text-amber-400"
        : "text-muted-foreground";
  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between">
          <span className={`flex items-center gap-1 text-xs ${riskColor}`}>
            <CircleAlert className="h-3 w-3" />
            {item.riskLevel.toUpperCase()} risk
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(item.createdAt).toLocaleTimeString()}
          </span>
        </div>
        <div>
          <p className="text-sm font-medium">{item.summary}</p>
          <p className="text-xs text-muted-foreground">{item.reason}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onDecide("denied")}
            data-testid={`button-deny-${item.id}`}
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="mr-1 h-4 w-4" />
            Reject
          </Button>
          <Button
            disabled={pending}
            onClick={() => onDecide("approved")}
            data-testid={`button-approve-${item.id}`}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <CheckCircle2 className="mr-1 h-4 w-4" />
            Approve
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
