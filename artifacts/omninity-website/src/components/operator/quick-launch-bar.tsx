import { useState } from "react";
import { Sparkles, Pin } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPinnedTaskTemplates,
  useRunTaskTemplate,
  getListTaskTemplatesQueryKey,
  getListPinnedTaskTemplatesQueryKey,
  type TaskTemplate,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { TemplateFillModal } from "./template-fill-modal";

interface Props {
  onResolved: (resolvedPrompt: string, template: TaskTemplate) => void;
}

export function QuickLaunchBar({ onResolved }: Props) {
  const qc = useQueryClient();
  const pinned = useListPinnedTaskTemplates();
  const runMutation = useRunTaskTemplate();
  const [active, setActive] = useState<TaskTemplate | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const items = pinned.data?.data.items ?? [];

  const launch = (tpl: TaskTemplate) => {
    if (tpl.variables.length === 0) {
      void runImmediate(tpl, {});
      return;
    }
    setActive(tpl);
    setModalOpen(true);
  };

  const runImmediate = async (tpl: TaskTemplate, values: Record<string, string>) => {
    const result = await runMutation.mutateAsync({
      id: tpl.id,
      data: { values },
    });
    onResolved(result.data.resolvedPrompt, result.data.template);
    await qc.invalidateQueries({ queryKey: getListTaskTemplatesQueryKey() });
    await qc.invalidateQueries({
      queryKey: getListPinnedTaskTemplatesQueryKey(),
    });
    setModalOpen(false);
    setActive(null);
  };

  if (items.length === 0) return null;

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2"
      data-testid="quick-launch-bar"
    >
      <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Pin className="h-3 w-3" /> Quick launch
      </span>
      {items.map((tpl) => (
        <Button
          key={tpl.id}
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          onClick={() => launch(tpl)}
          data-testid={`quick-launch-${tpl.id}`}
        >
          <Sparkles className="h-3 w-3" />
          {tpl.name}
        </Button>
      ))}
      <TemplateFillModal
        template={active}
        open={modalOpen}
        onOpenChange={(o) => {
          setModalOpen(o);
          if (!o) setActive(null);
        }}
        onSubmit={(values) =>
          active ? runImmediate(active, values) : Promise.resolve()
        }
        submitting={runMutation.isPending}
      />
    </div>
  );
}
