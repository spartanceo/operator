import { useEffect, useState } from "react";
import { Save, Download, RotateCcw } from "lucide-react";
import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  useListModels,
  usePullModel,
  useGetCurrentUser,
} from "@workspace/api-client-react";
import { HardwareModelSettings } from "@/components/operator/hardware-model-settings";
import { TelemetryCard } from "@/components/operator/telemetry-card";
import { DiagnosticsPanel } from "@/components/operator/diagnostics-panel";
import { useQueryClient } from "@tanstack/react-query";
import { useSettings } from "@/contexts/settings-context";
import { useTheme } from "@/contexts/theme-context";
import {
  getTenantId,
  getWorkspaceId,
  setTenantId as setApiTenantId,
  setWorkspaceId as setApiWorkspaceId,
} from "@/lib/api-config";
import { ErrorBanner } from "@/components/operator/error-banner";
import { JsonView } from "@/components/operator/json-view";
import { RemoteAccessCard } from "@/components/operator/remote-access-card";

export default function SettingsPage() {
  const { settings, update, reset } = useSettings();
  const { theme, setTheme } = useTheme();
  const qc = useQueryClient();

  const [draft, setDraft] = useState(settings);
  const [tenantId, setTenant] = useState(getTenantId());
  const [workspaceId, setWorkspace] = useState(getWorkspaceId());
  const [pullName, setPullName] = useState("");

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const modelsQuery = useListModels();
  const pull = usePullModel({
    mutation: {
      onSuccess: () => {
        setPullName("");
        void qc.invalidateQueries();
      },
    },
  });
  const currentUser = useGetCurrentUser({
    query: { retry: false } as never,
  });

  const onSave = () => {
    update(draft);
    setApiTenantId(tenantId.trim() || "operator-local");
    setApiWorkspaceId(workspaceId.trim() || `default-${tenantId || "operator-local"}`);
    void qc.invalidateQueries();
  };

  const onReset = () => {
    reset();
  };

  const onPull = () => {
    if (!pullName.trim()) return;
    pull.mutate({ data: { name: pullName.trim() } });
  };

  const dirty =
    draft.ollamaUrl !== settings.ollamaUrl ||
    draft.defaultModel !== settings.defaultModel ||
    draft.cloudMode !== settings.cloudMode ||
    draft.workspacePath !== settings.workspacePath ||
    tenantId !== getTenantId() ||
    workspaceId !== getWorkspaceId();

  return (
    <OperatorLayout
      title="Settings"
      description="Configure runtime, models, and workspace identity."
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onReset}
            data-testid="button-reset-settings"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
          <Button
            size="sm"
            onClick={onSave}
            disabled={!dirty}
            data-testid="button-save-settings"
          >
            <Save className="mr-1 h-3 w-3" />
            Save
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Appearance</CardTitle>
            <CardDescription className="text-xs">
              Toggle dark or light theme. Persists across sessions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Dark mode</p>
                <p className="text-xs text-muted-foreground">
                  Currently: {theme}
                </p>
              </div>
              <Switch
                checked={theme === "dark"}
                onCheckedChange={(v) => setTheme(v ? "dark" : "light")}
                data-testid="switch-theme"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Runtime</CardTitle>
            <CardDescription className="text-xs">
              Ollama endpoint and default model used by agents.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Ollama URL
              </label>
              <Input
                value={draft.ollamaUrl}
                onChange={(e) => setDraft({ ...draft, ollamaUrl: e.target.value })}
                data-testid="input-ollama-url"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Default model
              </label>
              <Input
                value={draft.defaultModel}
                onChange={(e) =>
                  setDraft({ ...draft, defaultModel: e.target.value })
                }
                data-testid="input-default-model"
                className="mt-1"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium">Cloud mode</p>
                <p className="text-xs text-muted-foreground">
                  Allow falling back to a hosted model when the local one is
                  unavailable.
                </p>
              </div>
              <Switch
                checked={draft.cloudMode}
                onCheckedChange={(v) => setDraft({ ...draft, cloudMode: v })}
                data-testid="switch-cloud-mode"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Workspace</CardTitle>
            <CardDescription className="text-xs">
              Tenant identity sent on every API request, and the local
              filesystem path the file tools may touch.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Tenant ID
              </label>
              <Input
                value={tenantId}
                onChange={(e) => setTenant(e.target.value)}
                data-testid="input-tenant-id"
                className="mt-1 font-mono text-xs"
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Workspace ID
              </label>
              <Input
                value={workspaceId}
                onChange={(e) => setWorkspace(e.target.value)}
                data-testid="input-workspace-id"
                className="mt-1 font-mono text-xs"
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Workspace path
              </label>
              <Input
                value={draft.workspacePath}
                onChange={(e) =>
                  setDraft({ ...draft, workspacePath: e.target.value })
                }
                data-testid="input-workspace-path"
                className="mt-1 font-mono text-xs"
              />
            </div>
          </CardContent>
        </Card>

        <HardwareModelSettings />

        <TelemetryCard />

        <div className="lg:col-span-2">
          <DiagnosticsPanel />
        </div>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Pull custom model</CardTitle>
            <CardDescription className="text-xs">
              All local models reported by Ollama, plus a manual `pull` for
              models outside the curated catalogue (advanced).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ErrorBanner error={modelsQuery.error} />
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Installed locally
              </p>
              <div
                className="mt-2 flex flex-wrap gap-1"
                data-testid="installed-models"
              >
                {(modelsQuery.data?.data.items ?? []).length === 0 ? (
                  <span className="text-xs italic text-muted-foreground">
                    No models reported.
                  </span>
                ) : (
                  (modelsQuery.data?.data.items ?? []).map((m) => (
                    <Badge
                      key={m.name}
                      variant="outline"
                      className="font-mono text-[10px]"
                    >
                      {m.name}
                    </Badge>
                  ))
                )}
              </div>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Pull a model by name
              </label>
              <div className="mt-1 flex gap-2">
                <Input
                  placeholder="e.g. llama3.1:8b"
                  value={pullName}
                  onChange={(e) => setPullName(e.target.value)}
                  data-testid="input-pull-model"
                />
                <Button
                  variant="outline"
                  onClick={onPull}
                  disabled={pull.isPending || !pullName.trim()}
                  data-testid="button-pull-model"
                >
                  <Download className="mr-1 h-3 w-3" />
                  {pull.isPending ? "Pulling…" : "Pull"}
                </Button>
              </div>
              <ErrorBanner error={pull.error} className="mt-2" />
              {pull.data ? (
                <p className="mt-2 text-xs text-emerald-500">
                  Pull queued: {pull.data.data.name} ({pull.data.data.status})
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <RemoteAccessCard />
        </div>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Account</CardTitle>
            <CardDescription className="text-xs">
              Information returned by <code>GET /api/auth/me</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {currentUser.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : currentUser.error ? (
              <p className="text-xs italic text-muted-foreground">
                Not signed in. Auth ships in a later milestone — tenant header is
                used for now.
              </p>
            ) : (
              <JsonView value={currentUser.data?.data ?? null} />
            )}
          </CardContent>
        </Card>
      </div>
    </OperatorLayout>
  );
}
