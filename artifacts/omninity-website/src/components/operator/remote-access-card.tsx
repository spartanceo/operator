/**
 * Remote Access settings card.
 *
 * Lives inside the operator Settings page. When the toggle is on, it
 * generates a fresh pairing token (the QR encodes the URL the PWA opens
 * to auto-claim it) and lists every paired device with per-device revoke.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { Loader2, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import {
  useListMobileDevices,
  useRevokeMobileDevice,
  useStartMobilePairing,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { qrToSvg } from "@/lib/qr";

interface PairingTokenView {
  code: string;
  relayToken: string;
  expiresAt: string;
  qrSvg: string;
  pairUrl: string;
}

const REMOTE_TOGGLE_KEY = "omninity.operator.remoteAccess";

function readToggle(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(REMOTE_TOGGLE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeToggle(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REMOTE_TOGGLE_KEY, on ? "1" : "0");
  } catch {
    /* storage disabled */
  }
}

function buildPairUrl(payload: object): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://example.com";
  const encoded = btoa(JSON.stringify(payload));
  return `${origin}/mobile#pair=${encodeURIComponent(encoded)}`;
}

export function RemoteAccessCard() {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState<boolean>(() => readToggle());
  const [token, setToken] = useState<PairingTokenView | null>(null);

  const start = useStartMobilePairing({
    mutation: {
      onSuccess: (resp) => {
        if (!resp.success) return;
        const payload = {
          v: 1,
          code: resp.data.code,
          token: resp.data.relayToken,
          expiresAt: new Date(resp.data.expiresAt).getTime(),
        };
        const pairUrl = buildPairUrl(payload);
        setToken({
          code: resp.data.code,
          relayToken: resp.data.relayToken ?? "",
          expiresAt: resp.data.expiresAt,
          qrSvg: qrToSvg(pairUrl, { scale: 5 }),
          pairUrl,
        });
      },
    },
  });

  const devices = useListMobileDevices({}, {
    query: { refetchInterval: enabled ? 10_000 : false } as never,
  });

  const revoke = useRevokeMobileDevice({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries();
      },
    },
  });

  // Mint a code automatically when the user flips the toggle on for the
  // first time so the QR is ready to scan immediately.
  useEffect(() => {
    if (enabled && !token && !start.isPending) {
      start.mutate(undefined as never);
    }
  }, [enabled, token, start]);

  const onToggle = (next: boolean) => {
    setEnabled(next);
    writeToggle(next);
    if (!next) setToken(null);
  };

  const onRefresh = () => {
    setToken(null);
    start.mutate(undefined as never);
  };

  const deviceList = useMemo(
    () => (devices.data?.success ? devices.data.data.items : []),
    [devices.data],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Smartphone className="h-4 w-4" />
          Remote Access
        </CardTitle>
        <CardDescription className="text-xs">
          Pair phones with the Mobile Companion PWA so you can approve actions and check
          progress on the go. Pairing is end-to-end via the local relay.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Enable remote access</p>
            <p className="text-xs text-muted-foreground">
              Off by default. Generates a QR pairing code when on.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            data-testid="switch-remote-access"
          />
        </div>

        {enabled ? (
          <div className="space-y-3 rounded-md border border-border/60 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Pairing code
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={start.isPending}
                data-testid="button-refresh-pairing"
              >
                {start.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
              </Button>
            </div>
            {token ? (
              <div className="space-y-3">
                <div
                  className="mx-auto w-fit rounded-md bg-white p-3"
                  data-testid="qr-pairing"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(token.qrSvg, { USE_PROFILES: { svg: true, svgFilters: true } }) }}
                />
                <div className="text-center font-mono text-2xl tracking-widest">
                  {token.code.replace(/(\d{4})(\d{4})/, "$1 $2")}
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  Expires {new Date(token.expiresAt).toLocaleTimeString()}
                </p>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Manual pairing details</summary>
                  <div className="mt-2 space-y-1 break-all rounded bg-muted/40 p-2 font-mono text-[10px]">
                    <div>URL: {token.pairUrl}</div>
                    <div>Token: {token.relayToken}</div>
                  </div>
                </details>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Generating fresh code…</p>
            )}
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Paired devices
          </p>
          {deviceList.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No devices paired yet. Scan the QR above on your phone to add one.
            </p>
          ) : (
            <ul className="divide-y divide-border/40 rounded-md border border-border/40">
              {deviceList.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                  data-testid={`device-row-${d.id}`}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{d.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.platform}
                      {d.lastSeenAt
                        ? ` · seen ${new Date(d.lastSeenAt).toLocaleString()}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {d.status === "active" ? (
                      <Badge variant="outline" className="text-emerald-400 border-emerald-400/40">
                        active
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        revoked
                      </Badge>
                    )}
                    {d.status === "active" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => revoke.mutate({ id: d.id })}
                        disabled={revoke.isPending}
                        data-testid={`button-revoke-${d.id}`}
                        title="Revoke"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
