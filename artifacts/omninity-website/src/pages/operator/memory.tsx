import { useState } from "react";
import { Brain, Plus, Trash2 } from "lucide-react";
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
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { HelpIcon, useHelp } from "@/components/help";

const KIND_OPTIONS = ["fact", "preference", "instruction", "skill", "note"];

export default function MemoryPage() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState("fact");
  const [importance, setImportance] = useState(50);

  const qc = useQueryClient();
  const { completeChecklistItem } = useHelp();
  const memoriesQuery = useListMemories({ limit: 100 });
  const memories = memoriesQuery.data?.data.items ?? [];

  const create = useCreateMemory({
    mutation: {
      onSuccess: () => {
        completeChecklistItem("memory");
        setTitle("");
        setContent("");
        setKind("fact");
        setImportance(50);
        setOpen(false);
        void qc.invalidateQueries();
      },
    },
  });

  const remove = useDeleteMemory({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const submit = () => {
    if (!title.trim() || !content.trim()) return;
    create.mutate({
      data: {
        title: title.trim(),
        content: content.trim(),
        kind,
        importance,
      },
    });
  };

  return (
    <OperatorLayout
      title="Memory"
      description="Long-lived context the agents can recall across runs."
      actions={
        <div className="flex items-center gap-2">
          <HelpIcon articleId="memory-system" label="How memory works" />
          <Dialog open={open} onOpenChange={setOpen}>
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
                Memories are scoped to your tenant and visible to all agents.
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
                  placeholder="e.g. Project workspace path"
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
                  <label
                    htmlFor="memory-kind"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Kind
                  </label>
                  <select
                    id="memory-kind"
                    data-testid="select-memory-kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {KIND_OPTIONS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
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
              </div>
              <ErrorBanner error={create.error} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={submit}
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

        {memories.length === 0 && !memoriesQuery.isLoading ? (
          <EmptyState
            icon={<Brain className="h-6 w-6" />}
            title="No memories saved yet"
            description="Add a memory and it will be available to every agent run."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {memories.map((m) => (
              <Card key={m.id} data-testid={`memory-card-${m.id}`}>
                <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-sm">{m.title}</CardTitle>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {m.kind}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        importance {m.importance}
                      </Badge>
                    </div>
                  </div>
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
                </CardHeader>
                <CardContent>
                  <p className="line-clamp-4 text-xs text-foreground/80">
                    {m.content}
                  </p>
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    Updated {new Date(m.updatedAt).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </OperatorLayout>
  );
}
