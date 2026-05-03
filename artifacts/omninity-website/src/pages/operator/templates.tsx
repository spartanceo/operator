import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Download,
  Upload,
  Sparkles,
  Tag,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTaskTemplates,
  useListPinnedTaskTemplates,
  useListTaskTemplateCategories,
  useCreateTaskTemplateCategory,
  useDeleteTaskTemplateCategory,
  useDeleteTaskTemplate,
  usePinTaskTemplate,
  exportTaskTemplate,
  useImportTaskTemplate,
  useRunTaskTemplate,
  getListTaskTemplatesQueryKey,
  getListPinnedTaskTemplatesQueryKey,
  getListTaskTemplateCategoriesQueryKey,
  type TaskTemplate,
} from "@workspace/api-client-react";
import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { TemplateFillModal } from "@/components/operator/template-fill-modal";
import { SaveTemplateDialog } from "@/components/operator/save-template-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

const ALL = "__all__";

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function TemplatesPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<TaskTemplate | null>(null);
  const [fillOpen, setFillOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const list = useListTaskTemplates({
    limit: 100,
    ...(categoryFilter !== ALL ? { categoryId: categoryFilter } : {}),
    ...(pinnedOnly ? { pinnedOnly: "true" as const } : {}),
    ...(search.trim() ? { q: search.trim() } : {}),
  });
  const pinned = useListPinnedTaskTemplates();
  const cats = useListTaskTemplateCategories();

  const pinMutation = usePinTaskTemplate();
  const deleteMutation = useDeleteTaskTemplate();
  const runMutation = useRunTaskTemplate();
  const importMutation = useImportTaskTemplate();
  const [exporting, setExporting] = useState(false);
  const createCat = useCreateTaskTemplateCategory();
  const deleteCat = useDeleteTaskTemplateCategory();

  const items = list.data?.data.items ?? [];
  const categories = cats.data?.data.items ?? [];
  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.id, c.name);
    return m;
  }, [categories]);

  const invalidateAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getListTaskTemplatesQueryKey() }),
      qc.invalidateQueries({ queryKey: getListPinnedTaskTemplatesQueryKey() }),
      qc.invalidateQueries({
        queryKey: getListTaskTemplateCategoriesQueryKey(),
      }),
    ]);
  };

  const handlePin = async (tpl: TaskTemplate) => {
    setError(null);
    try {
      await pinMutation.mutateAsync({
        id: tpl.id,
        data: { pinned: tpl.pinnedOrder == null },
      });
      await invalidateAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update pin");
    }
  };

  const handleDelete = async (tpl: TaskTemplate) => {
    if (!window.confirm(`Delete template "${tpl.name}"?`)) return;
    setError(null);
    try {
      await deleteMutation.mutateAsync({ id: tpl.id });
      await invalidateAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const handleRun = (tpl: TaskTemplate) => {
    setActive(tpl);
    setFillOpen(true);
  };

  const handleRunSubmit = async (values: Record<string, string>) => {
    if (!active) return;
    setError(null);
    try {
      const result = await runMutation.mutateAsync({
        id: active.id,
        data: { values },
      });
      await invalidateAll();
      setFillOpen(false);
      // Pass resolved prompt to chat via session storage so chat composer
      // can pick it up on mount.
      try {
        sessionStorage.setItem(
          "omninity:pendingPrompt",
          result.data.resolvedPrompt,
        );
        sessionStorage.setItem(
          "omninity:pendingPromptAgent",
          result.data.template.skillConfig?.agentMode ? "1" : "0",
        );
      } catch {
        // sessionStorage may be unavailable in some embedded contexts; ignore.
      }
      navigate("/chat");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run");
    }
  };

  const handleExport = async (tpl: TaskTemplate) => {
    setError(null);
    setExporting(true);
    try {
      const res = await exportTaskTemplate(tpl.id);
      downloadJson(
        `${tpl.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.template.json`,
        res.data,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to export");
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await importMutation.mutateAsync({ data: { template: parsed } });
      await invalidateAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import");
    }
  };

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    setError(null);
    try {
      await createCat.mutateAsync({ data: { name: newCatName.trim() } });
      setNewCatName("");
      await invalidateAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create category");
    }
  };

  const pinnedItems = pinned.data?.data.items ?? [];

  return (
    <OperatorLayout
      title="Task templates"
      description="Save reusable prompts with variables. Pin up to 5 for quick launch from chat."
      actions={
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImportFile(f);
              e.target.value = "";
            }}
            data-testid="input-import-template"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            data-testid="button-import-template"
          >
            <Upload className="mr-1 h-4 w-4" /> Import
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCatOpen(true)}
            data-testid="button-manage-categories"
          >
            <Tag className="mr-1 h-4 w-4" /> Categories
          </Button>
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            data-testid="button-new-template"
          >
            <Plus className="mr-1 h-4 w-4" /> New
          </Button>
        </div>
      }
    >
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <ErrorBanner error={list.error ?? error ?? null} />

        {pinnedItems.length > 0 ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Pin className="h-4 w-4" /> Pinned ({pinnedItems.length} / 5)
              </CardTitle>
              <CardDescription>
                Quick-launch row appears above the chat composer.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {pinnedItems.map((tpl) => (
                <Button
                  key={tpl.id}
                  size="sm"
                  variant="outline"
                  onClick={() => handleRun(tpl)}
                  className="gap-1"
                  data-testid={`pinned-row-${tpl.id}`}
                >
                  <Sparkles className="h-3 w-3" />
                  {tpl.name}
                </Button>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates…"
              className="pl-8"
              data-testid="input-search-templates"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger
              className="w-48"
              data-testid="select-filter-category"
            >
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={pinnedOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setPinnedOnly((v) => !v)}
            data-testid="button-toggle-pinned-only"
          >
            <Pin className="mr-1 h-3 w-3" /> Pinned only
          </Button>
        </div>

        {list.isLoading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Loading templates…
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            title="No templates yet"
            description="Save a chat prompt as a template, or click New to create one from scratch."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> New template
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3">
            {items.map((tpl) => (
              <Card key={tpl.id} data-testid={`template-card-${tpl.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-base">
                        {tpl.name}
                        {tpl.pinnedOrder != null ? (
                          <Badge variant="outline" className="gap-1 text-[10px]">
                            <Pin className="h-3 w-3" /> Pinned
                          </Badge>
                        ) : null}
                      </CardTitle>
                      {tpl.description ? (
                        <CardDescription>{tpl.description}</CardDescription>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>Used {tpl.usageCount}×</span>
                        {tpl.categoryId &&
                        categoryById.has(tpl.categoryId) ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {categoryById.get(tpl.categoryId)}
                          </Badge>
                        ) : null}
                        {tpl.variables.length > 0 ? (
                          <span>
                            {tpl.variables.length} variable
                            {tpl.variables.length === 1 ? "" : "s"}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        onClick={() => handleRun(tpl)}
                        data-testid={`button-use-${tpl.id}`}
                      >
                        <Sparkles className="mr-1 h-3 w-3" /> Use
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handlePin(tpl)}
                        aria-label={
                          tpl.pinnedOrder != null ? "Unpin" : "Pin"
                        }
                        data-testid={`button-pin-${tpl.id}`}
                      >
                        {tpl.pinnedOrder != null ? (
                          <PinOff className="h-4 w-4" />
                        ) : (
                          <Pin className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleExport(tpl)}
                        aria-label="Export"
                        data-testid={`button-export-${tpl.id}`}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleDelete(tpl)}
                        aria-label="Delete"
                        data-testid={`button-delete-${tpl.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <pre className="whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
                    {tpl.prompt}
                  </pre>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <TemplateFillModal
        template={active}
        open={fillOpen}
        onOpenChange={(o) => {
          setFillOpen(o);
          if (!o) setActive(null);
        }}
        onSubmit={handleRunSubmit}
        submitting={runMutation.isPending}
      />

      <SaveTemplateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialPrompt=""
      />

      <Dialog open={catOpen} onOpenChange={setCatOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage categories</DialogTitle>
            <DialogDescription>
              Categories help organise templates. Deleting a category leaves
              its templates uncategorised.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="new-cat">New category</Label>
              <div className="flex gap-2">
                <Input
                  id="new-cat"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  placeholder="e.g. Clients"
                  data-testid="input-new-category"
                />
                <Button
                  onClick={() => void handleCreateCategory()}
                  disabled={createCat.isPending || !newCatName.trim()}
                  data-testid="button-create-category"
                >
                  Add
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No categories yet.
                </p>
              ) : (
                categories.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded border border-border px-2 py-1 text-sm"
                  >
                    <span>{c.name}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={async () => {
                        if (!window.confirm(`Delete category "${c.name}"?`))
                          return;
                        try {
                          await deleteCat.mutateAsync({ id: c.id });
                          await invalidateAll();
                        } catch (e) {
                          setError(
                            e instanceof Error
                              ? e.message
                              : "Failed to delete category",
                          );
                        }
                      }}
                      aria-label="Delete category"
                      data-testid={`button-delete-category-${c.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCatOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </OperatorLayout>
  );
}
