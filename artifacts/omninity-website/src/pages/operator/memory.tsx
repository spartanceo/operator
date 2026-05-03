import { useMemo, useState } from "react";
import {
  Brain,
  Download,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
  Settings as SettingsIcon,
} from "lucide-react";
import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  useListMemories,
  useCreateMemory,
  useDeleteMemory,
  useUpdateMemory,
  useGetMemoryStats,
  useGetMemorySettings,
  useUpdateMemorySettings,
  exportMemories,
  useForgetAllMemories,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { HelpIcon, useHelp } from "@/components/help";
import { cn } from "@/lib/utils";

const CATEGORIES = ["fact", "preference", "pattern", "contact", "project"] as const;
const CONFIDENCES = ["confirmed", "observed", "inferred"] as const;

const CONFIDENCE_TONES: Record<string, string> = {
  confirmed: "border-emerald-500/40 text-emerald-500",
  observed: "border-amber-500/40 text-amber-500",
  inferred: "border-sky-500/40 text-sky-500",
};

const CATEGORY_TONES: Record<string, string> = {
  fact: "bg-slate-500/10 text-slate-200",
  preference: "bg-violet-500/10 text-violet-300",
  pattern: "bg-amber-500/10 text-amber-300",
  contact: "bg-emerald-500/10 text-emerald-300",
  project: "bg-sky-500/10 text-sky-300",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface EditState {
  id: string;
  title: string;
  content: string;
  category: string;
  confidence: string;
  importance: number;
  pinned: boolean;
}

export default function MemoryPage() {
  const qc = useQueryClient();
  const { completeChecklistItem } = useHelp();

  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<string>("fact");
  const [confidence, setConfidence] = useState<string>("confirmed");
  const [importance, setImportance] = useState(50);

  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterConfidence, setFilterConfidence] = useState<string>("");
  const [search, setSearch] = useState("");

  const params: Record<string, string | number> = { limit: 100 };
  if (filterCategory) params["category"] = filterCategory;
  if (filterConfidence) params["confidence"] = filterConfidence;
  if (search.trim()) params["q"] = search.trim();

  const memoriesQuery = useListMemories(params);
  const memories = memoriesQuery.data?.data.items ?? [];

  const statsQuery = useGetMemoryStats();
  const stats = statsQuery.data?.data;

  const settingsQuery = useGetMemorySettings();
  const settings = settingsQuery.data?.data;

  const create = useCreateMemory({
    mutation: {
      onSuccess: () => {
        completeChecklistItem("memory");
        setTitle("");
        setContent("");
        setCategory("fact");
        setConfidence("confirmed");
        setImportance(50);
        setCreateOpen(false);
        void qc.invalidateQueries();
      },
    },
  });

  const remove = useDeleteMemory({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const update = useUpdateMemory({
    mutation: {
      onSuccess: () => {
        setEdit(null);
        void qc.invalidateQueries();
      },
    },
  });

  const updateSettings = useUpdateMemorySettings({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const [exportError, setExportError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);

  const forgetAll = useForgetAllMemories({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const submitCreate = () => {
    if (!title.trim() || !content.trim()) return;
    create.mutate({
      data: {
        title: title.trim(),
        content: content.trim(),
        category: category as never,
        confidence: confidence as never,
        importance,
      },
    });
  };

  const submitEdit = () => {
    if (!edit) return;
    if (!edit.title.trim() || !edit.content.trim()) return;
    update.mutate({
      id: edit.id,
      data: {
        title: edit.title.trim(),
        content: edit.content.trim(),
        category: edit.category as never,
        confidence: edit.confidence as never,
        importance: edit.importance,
        pinned: edit.pinned,
      },
    });
  };

  const onExport = async (format: "json" | "markdown") => {
    setExportError(null);
    setExporting(true);
    try {
      const result = await exportMemories({ format });
      const payload = result.data;
      const blob = new Blob([payload.body], { type: payload.mediaType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `omninity-memories-${Date.now()}.${
        format === "markdown" ? "md" : "json"
      }`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e);
    } finally {
      setExporting(false);
    }
  };

  const onForgetAll = () => {
    const confirmed = window.prompt(
      'Type "FORGET" to permanently delete every memory in this workspace. This cannot be undone.',
    );
    if (confirmed !== "FORGET") return;
    forgetAll.mutate({ params: { confirm: "FORGET_EVERYTHING" } });
  };

  const capacityPct = useMemo(() => {
    if (!stats) return 0;
    if (stats.capacityBytes === 0) return 0;
    return Math.min(100, Math.round((stats.totalBytes / stats.capacityBytes) * 100));
  }, [stats]);

  return (
    <OperatorLayout
      title="Memory"
      description="What the agent has learned about you. Stored locally, scoped to this workspace."
      actions={
        <div className="flex items-center gap-2">
          <HelpIcon articleId="memory-system" label="How memory works" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => onExport("json")}
            disabled={exporting}
            data-testid="button-export-memory-json"
          >
            <Download className="mr-1 h-3 w-3" />
            JSON
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onExport("markdown")}
            disabled={exporting}
            data-testid="button-export-memory-md"
          >
            <Download className="mr-1 h-3 w-3" />
            Markdown
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            data-testid="button-memory-settings"
          >
            <SettingsIcon className="mr-1 h-3 w-3" />
            Settings
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onForgetAll}
            disabled={forgetAll.isPending}
            data-testid="button-forget-all-memory"
          >
            <Trash2 className="mr-1 h-3 w-3" />
            {forgetAll.isPending ? "Forgetting…" : "Forget all"}
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" data-testid="button-add-memory">
                <Plus className="mr-1 h-3 w-3" />
                New memory
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New memory</DialogTitle>
                <DialogDescription>
                  Memories are scoped to this workspace and visible to every agent run.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="memory-title"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Title
                  </label>
                  <Input
                    id="memory-title"
                    data-testid="input-memory-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. My manager is Sarah"
                  />
                </div>
                <div>
                  <label
                    htmlFor="memory-content"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Content
                  </label>
                  <Textarea
                    id="memory-content"
                    data-testid="input-memory-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[100px]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs uppercase tracking-wide text-muted-foreground">
                      Category
                    </label>
                    <select
                      data-testid="select-memory-category"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs uppercase tracking-wide text-muted-foreground">
                      Confidence
                    </label>
                    <select
                      data-testid="select-memory-confidence"
                      value={confidence}
                      onChange={(e) => setConfidence(e.target.value)}
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {CONFIDENCES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="memory-importance"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Importance ({importance})
                  </label>
                  <input
                    id="memory-importance"
                    data-testid="input-memory-importance"
                    type="range"
                    min={0}
                    max={100}
                    value={importance}
                    onChange={(e) => setImportance(Number(e.target.value))}
                    className="mt-3 w-full accent-primary"
                  />
                </div>
                <ErrorBanner error={create.error} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={submitCreate}
                  disabled={create.isPending || !title.trim() || !content.trim()}
                  data-testid="button-save-memory"
                >
                  {create.isPending ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      }
    >
      <div className="space-y-4 p-6">
        <ErrorBanner error={memoriesQuery.error} />
        <ErrorBanner error={remove.error} title="Delete failed" />
        <ErrorBanner error={forgetAll.error} title="Forget failed" />
        <ErrorBanner error={exportError} title="Export failed" />

        {stats ? (
          <Card data-testid="memory-stats-card">
            <CardContent className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-5">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Total
                </p>
                <p className="mt-1 text-2xl font-semibold">{stats.totalCount}</p>
              </div>
              {(["fact", "preference", "pattern"] as const).map((c) => (
                <div key={c}>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {c}
                  </p>
                  <p className="mt-1 text-2xl font-semibold">
                    {stats.byCategory?.[c] ?? 0}
                  </p>
                </div>
              ))}
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Storage
                </p>
                <p className="mt-1 text-sm font-semibold">
                  {formatBytes(stats.totalBytes)}{" "}
                  <span className="text-muted-foreground">/</span>{" "}
                  {formatBytes(stats.capacityBytes)}
                </p>
                <div className="mt-2 h-1.5 w-full rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-1.5 rounded-full",
                      capacityPct > 90 ? "bg-destructive" : "bg-primary",
                    )}
                    style={{ width: `${capacityPct}%` }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              data-testid="input-memory-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search memories…"
              className="h-9 pl-7"
            />
          </div>
          <select
            data-testid="filter-memory-category"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            data-testid="filter-memory-confidence"
            value={filterConfidence}
            onChange={(e) => setFilterConfidence(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All confidence</option>
            {CONFIDENCES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {memories.length === 0 && !memoriesQuery.isLoading ? (
          <EmptyState
            icon={<Brain className="h-6 w-6" />}
            title="No memories yet"
            description="Add a memory manually, or chat with the agent — it will record key facts automatically."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {memories.map((m) => (
              <Card key={m.id} data-testid={`memory-card-${m.id}`}>
                <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      {m.pinned ? (
                        <Pin className="h-3 w-3 text-amber-400" />
                      ) : null}
                      <CardTitle className="truncate text-sm">
                        {m.title}
                      </CardTitle>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] uppercase",
                          CATEGORY_TONES[m.category] ?? "",
                        )}
                      >
                        {m.category}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] uppercase",
                          CONFIDENCE_TONES[m.confidence] ?? "",
                        )}
                      >
                        {m.confidence}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        importance {m.importance}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit memory"
                      onClick={() =>
                        setEdit({
                          id: m.id,
                          title: m.title,
                          content: m.content,
                          category: m.category,
                          confidence: m.confidence,
                          importance: m.importance,
                          pinned: m.pinned,
                        })
                      }
                      data-testid={`button-edit-memory-${m.id}`}
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete memory"
                      onClick={() => remove.mutate({ id: m.id })}
                      disabled={remove.isPending}
                      data-testid={`button-delete-memory-${m.id}`}
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="line-clamp-4 text-xs text-foreground/80">
                    {m.content}
                  </p>
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    Updated {new Date(m.updatedAt).toLocaleString()}
                    {m.lastAccessedAt
                      ? ` · recalled ${m.accessCount}×`
                      : ""}
                    {m.sourceConversationId ? " · from chat" : ""}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit memory</DialogTitle>
            <DialogDescription>
              Update what the agent remembers about this fact.
            </DialogDescription>
          </DialogHeader>
          {edit ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Title
                </label>
                <Input
                  data-testid="input-edit-memory-title"
                  value={edit.title}
                  onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Content
                </label>
                <Textarea
                  data-testid="input-edit-memory-content"
                  value={edit.content}
                  onChange={(e) => setEdit({ ...edit, content: e.target.value })}
                  className="min-h-[100px]"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Category
                  </label>
                  <select
                    value={edit.category}
                    onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Confidence
                  </label>
                  <select
                    value={edit.confidence}
                    onChange={(e) =>
                      setEdit({ ...edit, confidence: e.target.value })
                    }
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {CONFIDENCES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Importance ({edit.importance})
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={edit.importance}
                  onChange={(e) =>
                    setEdit({ ...edit, importance: Number(e.target.value) })
                  }
                  className="mt-3 w-full accent-primary"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={edit.pinned}
                  onChange={(e) => setEdit({ ...edit, pinned: e.target.checked })}
                  data-testid="input-edit-memory-pinned"
                />
                Pin (never auto-prune)
              </label>
              <ErrorBanner error={update.error} />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitEdit}
              disabled={update.isPending}
              data-testid="button-save-edit-memory"
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Memory settings</DialogTitle>
            <DialogDescription>
              Control how aggressively the agent remembers and how much room it
              gets.
            </DialogDescription>
          </DialogHeader>
          {settings ? (
            <MemorySettingsForm
              capacityBytes={settings.capacityBytes}
              autoExtract={settings.autoExtract}
              onSave={(patch) =>
                updateSettings.mutate(
                  { data: patch },
                  { onSuccess: () => setSettingsOpen(false) },
                )
              }
              isSaving={updateSettings.isPending}
              error={updateSettings.error}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </OperatorLayout>
  );
}

function MemorySettingsForm({
  capacityBytes,
  autoExtract,
  onSave,
  isSaving,
  error,
}: {
  capacityBytes: number;
  autoExtract: boolean;
  onSave: (patch: { capacityBytes: number; autoExtract: boolean }) => void;
  isSaving: boolean;
  error: unknown;
}) {
  const [capMb, setCapMb] = useState(Math.round(capacityBytes / (1024 * 1024)));
  const [auto, setAuto] = useState(autoExtract);
  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wide text-muted-foreground">
          Capacity ({capMb} MB)
        </label>
        <input
          type="range"
          min={5}
          max={500}
          value={capMb}
          onChange={(e) => setCapMb(Number(e.target.value))}
          className="mt-3 w-full accent-primary"
          data-testid="input-memory-capacity"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          data-testid="input-memory-auto-extract"
        />
        Automatically learn from conversations
      </label>
      <ErrorBanner error={error} />
      <DialogFooter>
        <Button
          onClick={() =>
            onSave({ capacityBytes: capMb * 1024 * 1024, autoExtract: auto })
          }
          disabled={isSaving}
          data-testid="button-save-memory-settings"
        >
          {isSaving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </div>
  );
}
