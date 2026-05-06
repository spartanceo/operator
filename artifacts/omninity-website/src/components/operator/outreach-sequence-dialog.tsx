import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, GripVertical } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateOutreachSequence, useListCommAccounts } from "@workspace/api-client-react";
import { ErrorBanner } from "./error-banner";

interface Step {
  id: string;
  subject: string;
  body: string;
  delayDays: number;
}

export function OutreachSequenceDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const accounts = useListCommAccounts({ limit: 50 });
  const emailAccounts = (accounts.data?.data.items ?? []).filter(
    (a) => a.kind === "email" && a.status === "active",
  );
  const [steps, setSteps] = useState<Step[]>([
    { id: Math.random().toString(), subject: "", body: "", delayDays: 1 },
  ]);

  const create = useCreateOutreachSequence({
    mutation: {
      onSuccess: () => {
        setName("");
        setDescription("");
        setSteps([{ id: Math.random().toString(), subject: "", body: "", delayDays: 1 }]);
        setOpen(false);
        void qc.invalidateQueries();
      },
    },
  });

  const addStep = () => {
    setSteps([
      ...steps,
      { id: Math.random().toString(), subject: "", body: "", delayDays: 1 },
    ]);
  };

  const removeStep = (id: string) => {
    if (steps.length === 1) return;
    setSteps(steps.filter((s) => s.id !== id));
  };

  const updateStep = (id: string, field: keyof Step, value: Step[keyof Step]) => {
    setSteps(
      steps.map((s) => (s.id === id ? { ...s, [field]: value } : s))
    );
  };

  const moveStep = (index: number, direction: "up" | "down") => {
    const newSteps = [...steps];
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= steps.length) return;
    [newSteps[index], newSteps[targetIndex]] = [newSteps[targetIndex], newSteps[index]];
    setSteps(newSteps);
  };

  const isValid =
    accountId &&
    name.trim() &&
    steps.every((s) => s.subject.trim() && s.body.trim() && s.delayDays >= 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-new-sequence">
          <Plus className="mr-1 h-3 w-3" />
          New sequence
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create outreach sequence</DialogTitle>
          <DialogDescription>
            Define a multi-step email sequence for automated follow-ups.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">From account</label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger data-testid="select-sequence-account">
                <SelectValue placeholder="Pick an email account" />
              </SelectTrigger>
              <SelectContent>
                {emailAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Inbound SaaS Prospecting"
              data-testid="input-sequence-name"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Description</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. For new leads from the website"
              data-testid="input-sequence-description"
            />
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Steps</label>
              <Button type="button" variant="outline" size="sm" onClick={addStep}>
                <Plus className="mr-1 h-3 w-3" />
                Add step
              </Button>
            </div>
            {steps.map((step, index) => (
              <div
                key={step.id}
                className="relative space-y-3 rounded-lg border p-4 bg-muted/20"
                data-testid={`sequence-step-${index}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                      {index + 1}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {index === 0 ? "Initial Email" : `Follow-up ${index}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => moveStep(index, "up")}
                      disabled={index === 0}
                    >
                      <Plus className="h-4 w-4 rotate-45" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => removeStep(step.id)}
                      disabled={steps.length === 1}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-muted-foreground">Subject</label>
                    <Input
                      value={step.subject}
                      onChange={(e) => updateStep(step.id, "subject", e.target.value)}
                      placeholder="Email subject"
                      data-testid={`input-step-subject-${index}`}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-muted-foreground">Body</label>
                    <Textarea
                      value={step.body}
                      onChange={(e) => updateStep(step.id, "body", e.target.value)}
                      placeholder="Email body..."
                      rows={3}
                      data-testid={`input-step-body-${index}`}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">
                      Wait
                    </label>
                    <Input
                      type="number"
                      className="w-20"
                      value={step.delayDays}
                      onChange={(e) => updateStep(step.id, "delayDays", parseInt(e.target.value) || 0)}
                      min={0}
                      data-testid={`input-step-delay-${index}`}
                    />
                    <span className="text-xs text-muted-foreground">days after previous step</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {create.isError && <ErrorBanner error={create.error} />}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={!isValid || create.isPending}
            onClick={() =>
              create.mutate({
                data: {
                  accountId,
                  name: name.trim(),
                  description: description.trim(),
                  steps: steps.map((s) => ({
                    subject: s.subject.trim(),
                    body: s.body.trim(),
                    delayDays: s.delayDays,
                  })),
                },
              })
            }
            data-testid="button-save-sequence"
          >
            {create.isPending ? "Saving..." : "Save sequence"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
