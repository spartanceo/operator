import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useListContacts,
  useListOutreachSequences,
  useEnrolOutreachContact,
} from "@workspace/api-client-react";
import { ErrorBanner } from "./error-banner";

export function EnrolContactDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [contactId, setContactId] = useState("");
  const [sequenceId, setSequenceId] = useState("");

  const contactsQuery = useListContacts({ limit: 1000 });
  const sequencesQuery = useListOutreachSequences({ limit: 1000 });

  const enrol = useEnrolOutreachContact({
    mutation: {
      onSuccess: () => {
        setContactId("");
        setSequenceId("");
        setOpen(false);
        void qc.invalidateQueries();
      },
    },
  });

  const contacts = contactsQuery.data?.data.items ?? [];
  const sequences = sequencesQuery.data?.data.items.filter(s => s.status === "active") ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="button-enrol-contact">
          <UserPlus className="mr-1 h-3 w-3" />
          Enrol contact
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enrol contact in sequence</DialogTitle>
          <DialogDescription>
            Start an automated outreach sequence for a CRM contact.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Contact</label>
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger data-testid="select-enrol-contact">
                <SelectValue placeholder="Pick a contact" />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.displayName} ({c.email || "no email"})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Sequence</label>
            <Select value={sequenceId} onValueChange={setSequenceId}>
              <SelectTrigger data-testid="select-enrol-sequence">
                <SelectValue placeholder="Pick a sequence" />
              </SelectTrigger>
              <SelectContent>
                {sequences.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.steps.length} steps)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {enrol.isError && <ErrorBanner error={enrol.error} />}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={!contactId || !sequenceId || enrol.isPending}
            onClick={() =>
              enrol.mutate({
                data: {
                  contactId,
                  sequenceId,
                },
              })
            }
            data-testid="button-submit-enrol"
          >
            {enrol.isPending ? "Enrolling..." : "Enrol contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
