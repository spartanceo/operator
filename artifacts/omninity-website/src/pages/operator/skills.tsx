import { useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Plus,
  Download,
  Upload,
  Trash2,
  Star,
  Search,
  Filter as FilterIcon,
  Pencil,
} from "lucide-react";
import {
  useListSkills,
  useCreateSkill,
  useUpdateSkill,
  useDeleteSkill,
  useInstallSkill,
  useUninstallSkill,
  useImportSkill,
  exportSkill,
  type Skill,
  type SkillManifest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { cn } from "@/lib/utils";

// tier-review: bounded — fixed enum of skill categories the UI can target
const CATEGORIES = [
  "Productivity",
  "Developer Tools",
  "Communication",
  "Data",
  "Creative",
  "System",
  "Research",
  "Finance",
];

// tier-review: bounded — fixed enum of model families the picker filters on
const MODEL_FILTERS = [
  "all",
  "llama3.1",
  "qwen2.5",
  "mistral",
  "phi3",
  "gemma2",
];

function parseList(s: string): string[] {
  return s
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface SkillCardProps {
  skill: Skill;
  onInstall: (id: string) => void;
  onUninstall: (id: string) => void;
  onExport: (skill: Skill) => void;
  onEdit: (skill: Skill) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}

function SkillCard({
  skill,
  onInstall,
  onUninstall,
  onExport,
  onEdit,
  onDelete,
  busy,
}: SkillCardProps) {
  return (
    <Card data-testid={`skill-card-${skill.id}`} className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div className="min-w-0">
          <CardTitle className="truncate text-sm">{skill.name}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">by {skill.author}</p>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Star className="h-3.5 w-3.5 text-primary" />
          <span className="tabular-nums">{skill.installCount}</span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <p className="line-clamp-3 text-sm text-muted-foreground">
          {skill.description || "No description provided."}
        </p>
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
            {skill.category}
          </Badge>
          {skill.modelTags.slice(0, 3).map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">
              {t}
            </Badge>
          ))}
        </div>
        <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-3">
          <div className="flex items-center gap-2">
            <Switch
              data-testid={`switch-install-${skill.id}`}
              checked={skill.isInstalled}
              disabled={busy}
              onCheckedChange={(v) =>
                v ? onInstall(skill.id) : onUninstall(skill.id)
              }
              aria-label={skill.isInstalled ? "Uninstall" : "Install"}
            />
            <span className="text-xs text-muted-foreground">
              {skill.isInstalled ? "Installed" : "Not installed"}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              data-testid={`button-edit-${skill.id}`}
              onClick={() => onEdit(skill)}
              aria-label="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`button-export-${skill.id}`}
              onClick={() => onExport(skill)}
              aria-label="Export"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`button-delete-${skill.id}`}
              onClick={() => onDelete(skill.id)}
              aria-label="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface SkillFormState {
  name: string;
  description: string;
  content: string;
  modelTags: string;
  triggers: string;
  category: string;
}

const EMPTY_FORM: SkillFormState = {
  name: "",
  description: "",
  content: "",
  modelTags: "",
  triggers: "",
  category: "Productivity",
};

export default function SkillsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"all" | "installed">("all");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [form, setForm] = useState<SkillFormState>(EMPTY_FORM);
  const [importOpen, setImportOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Import state
  const [importJson, setImportJson] = useState("");
  const [installOnImport, setInstallOnImport] = useState(true);

  const listParams = useMemo(
    () => ({
      limit: 100,
      ...(category !== "all" ? { category } : {}),
      ...(tab === "installed" ? { installed: true as const } : {}),
      ...(search.trim().length > 0 ? { search: search.trim() } : {}),
    }),
    [category, tab, search],
  );

  const skillsQuery = useListSkills(listParams);
  const allItems = skillsQuery.data?.data.items ?? [];
  // Client-side model-tag filter on top of the server-side query so that the
  // server stays generic; the bounded MODEL_FILTERS list keeps the UI fast.
  const items = useMemo(() => {
    if (modelFilter === "all") return allItems;
    return allItems.filter((s) =>
      s.modelTags.some((t) => t.toLowerCase().includes(modelFilter)),
    );
  }, [allItems, modelFilter]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setEditingVersion(null);
  };

  const openCreate = () => {
    resetForm();
    setFormOpen(true);
  };

  const openEdit = (skill: Skill) => {
    setEditingId(skill.id);
    setEditingVersion(skill.version);
    setForm({
      name: skill.name,
      description: skill.description ?? "",
      content: skill.content,
      modelTags: skill.modelTags.join(", "),
      triggers: skill.triggers.join(", "),
      category: skill.category,
    });
    setFormOpen(true);
  };

  const create = useCreateSkill({
    mutation: {
      onSuccess: () => {
        resetForm();
        setFormOpen(false);
        void qc.invalidateQueries();
      },
    },
  });
  const update = useUpdateSkill({
    mutation: {
      onSuccess: () => {
        resetForm();
        setFormOpen(false);
        void qc.invalidateQueries();
      },
    },
  });

  const install = useInstallSkill({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });
  const uninstall = useUninstallSkill({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });
  const remove = useDeleteSkill({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });
  const importMutation = useImportSkill({
    mutation: {
      onSuccess: () => {
        setImportJson("");
        setImportOpen(false);
        void qc.invalidateQueries();
      },
    },
  });

  const submitForm = () => {
    if (!form.name.trim() || !form.content.trim()) return;
    if (editingId && editingVersion !== null) {
      update.mutate({
        id: editingId,
        data: {
          name: form.name.trim(),
          description: form.description.trim(),
          content: form.content,
          modelTags: parseList(form.modelTags),
          triggers: parseList(form.triggers),
          category: form.category,
          version: editingVersion,
        },
      });
    } else {
      create.mutate({
        data: {
          name: form.name.trim(),
          description: form.description.trim(),
          content: form.content,
          modelTags: parseList(form.modelTags),
          triggers: parseList(form.triggers),
          category: form.category,
        },
      });
    }
  };

  const [exportError, setExportError] = useState<unknown>(null);
  const handleExport = async (skill: Skill) => {
    setExportError(null);
    try {
      const resp = await exportSkill(skill.id);
      downloadJson(`${skill.slug}.skill.json`, resp.data);
    } catch (e) {
      setExportError(e);
    }
  };

  const onPickFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setImportJson(text);
      setImportOpen(true);
    };
    reader.readAsText(file);
  };

  const submitImport = () => {
    let manifest: SkillManifest;
    try {
      manifest = JSON.parse(importJson) as SkillManifest;
    } catch {
      return;
    }
    importMutation.mutate({
      data: { manifest, install: installOnImport },
    });
  };

  return (
    <OperatorLayout
      title="Skills"
      description="Local-first skill packages. Install, build, import, export — all on this device."
      actions={
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json,.skill"
            className="hidden"
            data-testid="input-skill-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPickFile(file);
              e.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="button-import-skill"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mr-1 h-3 w-3" />
            Import
          </Button>
          <Dialog
            open={formOpen}
            onOpenChange={(open) => {
              setFormOpen(open);
              if (!open) resetForm();
            }}
          >
            <DialogTrigger asChild>
              <Button
                size="sm"
                data-testid="button-add-skill"
                onClick={openCreate}
              >
                <Plus className="mr-1 h-3 w-3" />
                New skill
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>
                  {editingId ? "Edit skill" : "New skill"}
                </DialogTitle>
                <DialogDescription>
                  Skills are reusable instruction sets your agents can pick up.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="skill-name"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Name
                  </label>
                  <Input
                    id="skill-name"
                    data-testid="input-skill-name"
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, name: e.target.value }))
                    }
                    placeholder="e.g. Inbox triage"
                  />
                </div>
                <div>
                  <label
                    htmlFor="skill-desc"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Description
                  </label>
                  <Input
                    id="skill-desc"
                    data-testid="input-skill-description"
                    value={form.description}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, description: e.target.value }))
                    }
                    placeholder="One sentence about what it does"
                  />
                </div>
                <div>
                  <label
                    htmlFor="skill-content"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    System prompt
                  </label>
                  <Textarea
                    id="skill-content"
                    data-testid="input-skill-content"
                    value={form.content}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, content: e.target.value }))
                    }
                    className="min-h-[140px] font-mono text-xs"
                    placeholder="Detailed instructions the planner will use as system context"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="skill-tags"
                      className="text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      Model tags (comma)
                    </label>
                    <Input
                      id="skill-tags"
                      data-testid="input-skill-model-tags"
                      value={form.modelTags}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, modelTags: e.target.value }))
                      }
                      placeholder="llama3.1, qwen2.5"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="skill-triggers"
                      className="text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      Trigger words (comma)
                    </label>
                    <Input
                      id="skill-triggers"
                      data-testid="input-skill-triggers"
                      value={form.triggers}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, triggers: e.target.value }))
                      }
                      placeholder="triage, inbox"
                    />
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="skill-category"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Category
                  </label>
                  <Select
                    value={form.category}
                    onValueChange={(v) =>
                      setForm((f) => ({ ...f, category: v }))
                    }
                  >
                    <SelectTrigger id="skill-category" data-testid="select-skill-category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <ErrorBanner error={create.error || update.error} />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setFormOpen(false);
                    resetForm();
                  }}
                >
                  Cancel
                </Button>
                <Button
                  data-testid="button-save-skill"
                  onClick={submitForm}
                  disabled={
                    create.isPending ||
                    update.isPending ||
                    !form.name.trim() ||
                    !form.content.trim()
                  }
                >
                  {editingId
                    ? update.isPending
                      ? "Updating…"
                      : "Update"
                    : create.isPending
                      ? "Saving…"
                      : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      }
    >
      <div className="space-y-4 p-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "all" | "installed")}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <TabsList>
              <TabsTrigger value="all" data-testid="tab-all">
                All skills
              </TabsTrigger>
              <TabsTrigger value="installed" data-testid="tab-installed">
                Installed
              </TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  data-testid="input-search-skills"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="h-9 w-56 pl-8"
                />
              </div>
              <FilterIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger
                  className="h-9 w-44"
                  data-testid="select-skill-category-filter"
                >
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Model filter row — bounded list of supported model families */}
          <div
            className="mt-3 flex flex-wrap items-center gap-1.5"
            data-testid="model-filter-tabs"
          >
            <span className="mr-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Model
            </span>
            {MODEL_FILTERS.map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`model-filter-${m}`}
                onClick={() => setModelFilter(m)}
                className={cn(
                  "hover-elevate rounded-full border px-3 py-1 text-xs",
                  modelFilter === m
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground",
                )}
              >
                {m === "all" ? "All models" : m}
              </button>
            ))}
          </div>

          <ErrorBanner error={skillsQuery.error} className="mt-4" />
          <ErrorBanner error={install.error || uninstall.error} title="Install failed" className="mt-4" />
          <ErrorBanner error={remove.error} title="Delete failed" className="mt-4" />
          <ErrorBanner error={importMutation.error} title="Import failed" className="mt-4" />
          <ErrorBanner error={exportError} title="Export failed" className="mt-4" />

          <TabsContent value={tab} className="mt-4">
            {items.length === 0 && !skillsQuery.isLoading ? (
              <EmptyState
                icon={<Sparkles className="h-6 w-6" />}
                title={
                  tab === "installed"
                    ? "No skills installed yet"
                    : "No skills here yet"
                }
                description={
                  tab === "installed"
                    ? "Install a skill from the All skills tab and it will be available to every agent run."
                    : "Create your first skill or import a .skill JSON file."
                }
              />
            ) : (
              <div
                className={cn(
                  "grid grid-cols-1 gap-3",
                  "md:grid-cols-2 xl:grid-cols-3",
                )}
              >
                {items.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    busy={
                      install.isPending ||
                      uninstall.isPending ||
                      remove.isPending
                    }
                    onInstall={(id) => install.mutate({ id })}
                    onUninstall={(id) => uninstall.mutate({ id })}
                    onExport={handleExport}
                    onEdit={openEdit}
                    onDelete={(id) => {
                      if (
                        typeof window !== "undefined" &&
                        window.confirm(`Delete "${skill.name}"?`)
                      ) {
                        remove.mutate({ id });
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Import skill</DialogTitle>
            <DialogDescription>
              Review the manifest before adding it to your tenant.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            data-testid="input-import-json"
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            className="min-h-[220px] font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <Switch
              id="install-on-import"
              data-testid="switch-install-on-import"
              checked={installOnImport}
              onCheckedChange={setInstallOnImport}
            />
            <label htmlFor="install-on-import" className="text-sm">
              Install immediately
            </label>
          </div>
          <ErrorBanner error={importMutation.error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              data-testid="button-confirm-import"
              onClick={submitImport}
              disabled={importMutation.isPending || importJson.trim().length === 0}
            >
              {importMutation.isPending ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </OperatorLayout>
  );
}
