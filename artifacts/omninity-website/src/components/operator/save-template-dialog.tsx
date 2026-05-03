import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateTaskTemplate,
  useListTaskTemplateCategories,
  getListTaskTemplatesQueryKey,
  getListPinnedTaskTemplatesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const NO_CATEGORY = "__none__";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPrompt: string;
  initialAgentMode?: boolean;
  initialModel?: string | null;
  initialConversationId?: string | null;
  onSaved?: () => void;
}

function detectVariables(prompt: string): string[] {
  const re = /\{\{\s*([a-zA-Z0-9_]{1,40})\s*\}\}/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    seen.add(m[1]!);
  }
  return Array.from(seen);
}

export function SaveTemplateDialog({
  open,
  onOpenChange,
  initialPrompt,
  initialAgentMode,
  initialModel,
  initialConversationId,
  onSaved,
}: Props) {
  const qc = useQueryClient();
  const cats = useListTaskTemplateCategories();
  const create = useCreateTaskTemplate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [categoryId, setCategoryId] = useState<string>(NO_CATEGORY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPrompt(initialPrompt);
      setName("");
      setDescription("");
      setCategoryId(NO_CATEGORY);
      setError(null);
    }
  }, [open, initialPrompt]);

  const detectedVars = useMemo(() => detectVariables(prompt), [prompt]);

  const submit = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setError(null);
    try {
      await create.mutateAsync({
        data: {
          name: name.trim(),
          description: description.trim() || null,
          prompt: prompt,
          variables: detectedVars.map((n) => ({
            name: n,
            label: n.replace(/[_-]/g, " "),
            required: true,
          })),
          skillConfig: {
            ...(initialAgentMode !== undefined
              ? { agentMode: initialAgentMode }
              : {}),
            ...(initialModel ? { model: initialModel } : {}),
            ...(initialConversationId
              ? { conversationId: initialConversationId }
              : {}),
          },
          categoryId: categoryId === NO_CATEGORY ? null : categoryId,
        },
      });
      await qc.invalidateQueries({ queryKey: getListTaskTemplatesQueryKey() });
      await qc.invalidateQueries({
        queryKey: getListPinnedTaskTemplatesQueryKey(),
      });
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save template");
    }
  };

  const categories = (((cats.data?.data as any)?.items ?? []) as any[]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-save-template">
        <DialogHeader>
          <DialogTitle>Save as task template</DialogTitle>
          <DialogDescription>
            Reuse this prompt later. Wrap dynamic parts in{" "}
            <code className="rounded bg-muted px-1">{`{{name}}`}</code> to turn
            them into fillable variables.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="tpl-name">Name</Label>
            <Input
              id="tpl-name"
              data-testid="input-template-name"
              value={name}
              placeholder="Weekly client report"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-desc">Description (optional)</Label>
            <Input
              id="tpl-desc"
              value={description}
              placeholder="What this template does…"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-prompt">Prompt</Label>
            <Textarea
              id="tpl-prompt"
              data-testid="input-template-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-[140px] font-mono text-xs"
            />
            {detectedVars.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Variables detected:{" "}
                <span className="font-medium">
                  {detectedVars.join(", ")}
                </span>
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger data-testid="select-template-category">
                <SelectValue placeholder="Uncategorised" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>Uncategorised</SelectItem>
                {categories.map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={create.isPending || !name.trim() || !prompt.trim()}
            data-testid="button-save-template"
          >
            {create.isPending ? "Saving…" : "Save template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
