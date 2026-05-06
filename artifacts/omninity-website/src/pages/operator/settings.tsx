import { useEffect, useId, useState } from "react";
import { Save, Download, RotateCcw, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  useListVoices,
  useSynthesizeSpeech,
} from "@workspace/api-client-react";
import { HardwareModelSettings } from "@/components/operator/hardware-model-settings";
import { CapabilityRuntimeSettings } from "@/components/operator/capability-runtime-settings";
import { TelemetryCard } from "@/components/operator/telemetry-card";
import { DiagnosticsPanel } from "@/components/operator/diagnostics-panel";
import {
  isSpeechRecognitionSupported,
  useVoicePlayer,
} from "@/lib/voice-engine";
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
import { LanguageSwitcher } from "@/components/a11y/language-switcher";

export default function SettingsPage() {
  const { t } = useTranslation();
  const { settings, update, reset } = useSettings();
  const { theme, setTheme } = useTheme();
  const qc = useQueryClient();

  const [draft, setDraft] = useState(settings);
  const [tenantId, setTenant] = useState(getTenantId());
  const [workspaceId, setWorkspace] = useState(getWorkspaceId());
  const [pullName, setPullName] = useState("");

  const ollamaUrlId = useId();
  const defaultModelId = useId();
  const tenantInputId = useId();
  const workspaceInputId = useId();
  const workspacePathId = useId();
  const pullInputId = useId();

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
    draft.voiceMode !== settings.voiceMode ||
    draft.voiceName !== settings.voiceName ||
    draft.voiceSpeed !== settings.voiceSpeed ||
    draft.voiceAutoplay !== settings.voiceAutoplay ||
    draft.wakeWordEnabled !== settings.wakeWordEnabled ||
    draft.wakeWordPhrase !== settings.wakeWordPhrase ||
    tenantId !== getTenantId() ||
    workspaceId !== getWorkspaceId();

  const voicesQuery = useListVoices();
  const previewSynth = useSynthesizeSpeech();
  const previewPlayer = useVoicePlayer();
  const speechSupported = isSpeechRecognitionSupported();

  const onPreviewVoice = async () => {
    try {
      const resp = await previewSynth.mutateAsync({
        data: {
          text:
            "Hi, this is the Omninity Operator. The voice interface is ready.",
          voice: draft.voiceName,
          speed: draft.voiceSpeed,
        },
      });
      await previewPlayer.play(resp.data.audio, resp.data.mimeType);
    } catch {
      /* surfaced via mutation error */
    }
  };

  return (
    <OperatorLayout
      title={t("settings.title")}
      description={t("settings.description")}
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onReset}
            data-testid="button-reset-settings"
          >
            <RotateCcw className="me-1 h-3 w-3" aria-hidden="true" />
            {t("settings.reset")}
          </Button>
          <Button
            size="sm"
            onClick={onSave}
            disabled={!dirty}
            data-testid="button-save-settings"
          >
            <Save className="me-1 h-3 w-3" aria-hidden="true" />
            {t("settings.save")}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings.appearance.title")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("settings.appearance.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">
                  {t("settings.appearance.darkMode")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.appearance.currently", { theme })}
                </p>
              </div>
              <Switch
                checked={theme === "dark"}
                onCheckedChange={(v) => setTheme(v ? "dark" : "light")}
                data-testid="switch-theme"
                aria-label={t("settings.appearance.darkMode")}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings.language.title")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("settings.language.description")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LanguageSwitcher data-testid="settings-language-switcher" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings.runtime.title")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("settings.runtime.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label
                htmlFor={ollamaUrlId}
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                {t("settings.runtime.ollamaUrl")}
              </label>
              <Input
                id={ollamaUrlId}
                value={draft.ollamaUrl}
                onChange={(e) => setDraft({ ...draft, ollamaUrl: e.target.value })}
                data-testid="input-ollama-url"
                className="mt-1"
              />
            </div>
            <div>
              <label
                htmlFor={defaultModelId}
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                {t("settings.runtime.defaultModel")}
              </label>
              <Input
                id={defaultModelId}
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
                <p className="text-sm font-medium">
                  {t("settings.runtime.cloudMode")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.runtime.cloudModeDescription")}
                </p>
              </div>
              <Switch
                checked={draft.cloudMode}
                onCheckedChange={(v) => setDraft({ ...draft, cloudMode: v })}
                data-testid="switch-cloud-mode"
                aria-label={t("settings.runtime.cloudMode")}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings.workspace.title")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("settings.workspace.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label
                htmlFor={tenantInputId}
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                {t("settings.workspace.tenantId")}
              </label>
              <Input
                id={tenantInputId}
                value={tenantId}
                onChange={(e) => setTenant(e.target.value)}
                data-testid="input-tenant-id"
                className="mt-1 font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor={workspaceInputId}
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                {t("settings.workspace.workspaceId")}
              </label>
              <Input
                id={workspaceInputId}
                value={workspaceId}
                onChange={(e) => setWorkspace(e.target.value)}
                data-testid="input-workspace-id"
                className="mt-1 font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor={workspacePathId}
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                {t("settings.workspace.workspacePath")}
              </label>
              <Input
                id={workspacePathId}
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

        <CapabilityRuntimeSettings />

        <TelemetryCard />

        <div className="lg:col-span-2">
          <DiagnosticsPanel />
        </div>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings.pull.title")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("settings.pull.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ErrorBanner error={modelsQuery.error} />
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("settings.pull.installed")}
              </p>
              <div
                className="mt-2 flex flex-wrap gap-1"
                data-testid="installed-models"
              >
                {(modelsQuery.data?.data.items ?? []).length === 0 ? (
                  <span className="text-xs italic text-muted-foreground">
                    {t("settings.pull.noModels")}
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
              <label
                htmlFor={pullInputId}
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                {t("settings.pull.label")}
              </label>
              <div className="mt-1 flex gap-2">
                <Input
                  id={pullInputId}
                  placeholder={t("settings.pull.placeholder")}
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
                  <Download className="me-1 h-3 w-3" aria-hidden="true" />
                  {pull.isPending
                    ? t("settings.pull.actionPending")
                    : t("settings.pull.action")}
                </Button>
              </div>
              <ErrorBanner error={pull.error} className="mt-2" />
              {pull.data ? (
                <p className="mt-2 text-xs text-emerald-500">
                  {t("settings.pull.queued", {
                    name: pull.data.data.name,
                    status: pull.data.data.status,
                  })}
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
            <CardTitle className="text-base flex items-center gap-2">
              <Volume2 className="h-4 w-4" aria-hidden="true" /> Voice interface
            </CardTitle>
            <CardDescription className="text-xs">
              Local speech-to-text and text-to-speech. Microphone access is
              only requested after you press the mic button on the chat screen.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium">Voice mode</p>
                <p className="text-xs text-muted-foreground">
                  Auto-send transcribed speech and play replies aloud.
                </p>
              </div>
              <Switch
                checked={draft.voiceMode}
                onCheckedChange={(v) => setDraft({ ...draft, voiceMode: v })}
                data-testid="switch-voice-mode-settings"
                aria-label="Voice mode"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium">Speak replies</p>
                <p className="text-xs text-muted-foreground">
                  Render assistant replies through the local TTS engine.
                </p>
              </div>
              <Switch
                checked={draft.voiceAutoplay}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, voiceAutoplay: v })
                }
                data-testid="switch-voice-autoplay"
                aria-label="Speak replies"
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Voice
              </label>
              <Select
                value={draft.voiceName}
                onValueChange={(v) => setDraft({ ...draft, voiceName: v })}
              >
                <SelectTrigger data-testid="select-voice" className="mt-1" aria-label="Voice">
                  <SelectValue placeholder="Pick a voice" />
                </SelectTrigger>
                <SelectContent>
                  {(voicesQuery.data?.data.items ?? []).length === 0 ? (
                    <SelectItem value={draft.voiceName} disabled>
                      {draft.voiceName} (loading…)
                    </SelectItem>
                  ) : (
                    (voicesQuery.data?.data.items ?? []).map((v: any) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Speed ({draft.voiceSpeed.toFixed(2)}×)
              </label>
              <Slider
                value={[draft.voiceSpeed]}
                onValueChange={([v]) =>
                  setDraft({ ...draft, voiceSpeed: v ?? 1 })
                }
                min={0.5}
                max={2}
                step={0.05}
                className="mt-3"
                data-testid="slider-voice-speed"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium">Wake word</p>
                <p className="text-xs text-muted-foreground">
                  {speechSupported
                    ? "Continuously listens for the phrase below."
                    : "Not supported in this browser."}
                </p>
              </div>
              <Switch
                checked={draft.wakeWordEnabled}
                disabled={!speechSupported}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, wakeWordEnabled: v })
                }
                data-testid="switch-wake-word"
                aria-label="Wake word listening"
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Wake phrase
              </label>
              <Input
                value={draft.wakeWordPhrase}
                onChange={(e) =>
                  setDraft({ ...draft, wakeWordPhrase: e.target.value })
                }
                placeholder="hey op"
                data-testid="input-wake-phrase"
                className="mt-1"
              />
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onPreviewVoice}
                disabled={previewSynth.isPending || previewPlayer.isPlaying}
                data-testid="button-preview-voice"
              >
                {previewPlayer.isPlaying
                  ? "Playing…"
                  : previewSynth.isPending
                    ? "Synthesising…"
                    : "Preview voice"}
              </Button>
              {previewPlayer.isPlaying ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={previewPlayer.stop}
                  data-testid="button-preview-stop"
                >
                  Stop
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">
                Sample uses the current voice + speed.
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings.account.title")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("settings.account.description")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {currentUser.isLoading ? (
              <p className="text-xs text-muted-foreground">
                {t("settings.loading")}
              </p>
            ) : currentUser.error ? (
              <p className="text-xs italic text-muted-foreground">
                {t("settings.account.notSignedIn")}
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
