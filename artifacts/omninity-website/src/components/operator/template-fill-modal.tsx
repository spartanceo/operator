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
import type { TaskTemplate } from "@workspace/api-client-react";

interface Props {
  template: TaskTemplate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
  submitting?: boolean;
}

export function TemplateFillModal({
  template,
  open,
  onOpenChange,
  onSubmit,
  submitting,
}: Props) {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!template) return;
    const next: Record<string, string> = {};
    for (const v of template.variables) {
      next[v.name] = v.defaultValue ?? "";
    }
    setValues(next);
  }, [template?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const missing = useMemo(() => {
    if (!template) return [];
    return template.variables
      .filter((v) => v.required && !(values[v.name] ?? "").trim())
      .map((v) => v.label);
  }, [template, values]);

  const preview = useMemo(() => {
    if (!template) return "";
    let out = template.prompt;
    for (const v of template.variables) {
      const val = values[v.name] ?? v.defaultValue ?? "";
      out = out.split(`{{${v.name}}}`).join(val);
    }
    return out;
  }, [template, values]);

  if (!template) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="dialog-template-fill">
        <DialogHeader>
          <DialogTitle>Run "{template.name}"</DialogTitle>
          {template.description ? (
            <DialogDescription>{template.description}</DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="space-y-3 py-2">
          {template.variables.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No variables — the template will run as-is.
            </p>
          ) : (
            template.variables.map((v) => (
              <div key={v.name} className="space-y-1">
                <Label htmlFor={`tplvar-${v.name}`}>
                  {v.label}
                  {v.required ? (
                    <span className="ml-1 text-destructive">*</span>
                  ) : null}
                </Label>
                <Input
                  id={`tplvar-${v.name}`}
                  data-testid={`input-tplvar-${v.name}`}
                  value={values[v.name] ?? ""}
                  placeholder={v.defaultValue ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                  }
                />
              </div>
            ))
          )}

          <div className="space-y-1 pt-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Resolved prompt
            </Label>
            <Textarea
              readOnly
              value={preview}
              className="min-h-[120px] font-mono text-xs"
              data-testid="text-template-preview"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void onSubmit(values)}
            disabled={submitting || missing.length > 0}
            data-testid="button-template-run"
          >
            {missing.length > 0
              ? `Fill: ${missing.join(", ")}`
              : submitting
                ? "Running…"
                : "Use template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
