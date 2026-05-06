import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Inbox,
  Send,
  CalendarDays,
  PhoneCall,
  Users,
  Workflow,
  Plug,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  useListCommAccounts,
  useConnectCommAccount,
  useDisconnectCommAccount,
  useListEmailMessages,
  useListEmailDrafts,
  useCreateEmailDraft,
  useSendEmailDraft,
  useDenyEmailDraft,
  useListCalendarEvents,
  useCreateCalendarEvent,
  useDeleteCalendarEvent,
  useListVoipCalls,
  usePlaceVoipCall,
  useListContacts,
  useCreateContact,
  useDeleteContact,
  useListOutreachSequences,
  useRunOutreachSteps,
  useListOutreachEnrolments,
  useSetOutreachSequenceStatus,
} from "@workspace/api-client-react";
import { OperatorLayout } from "@/components/operator/layout";
import { OutreachSequenceDialog } from "@/components/operator/outreach-sequence-dialog";
import { EnrolContactDialog } from "@/components/operator/enrol-contact-dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
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
import { EmptyState } from "@/components/operator/empty-state";
import { ErrorBanner } from "@/components/operator/error-banner";

const PROVIDER_OPTIONS = [
  { value: "gmail", label: "Gmail (email)" },
  { value: "outlook", label: "Outlook (email)" },
  { value: "google_calendar", label: "Google Calendar" },
  { value: "apple_calendar", label: "Apple Calendar" },
  { value: "twilio", label: "Twilio (VoIP)" },
] as const;

type Provider = (typeof PROVIDER_OPTIONS)[number]["value"];

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusVariant(
  s: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (["active", "approved", "sent", "completed", "confirmed"].includes(s)) {
    return "default";
  }
  if (["pending", "queued", "ringing", "in_progress", "tentative"].includes(s)) {
    return "secondary";
  }
  if (["denied", "failed", "stopped", "disconnected", "error"].includes(s)) {
    return "destructive";
  }
  return "outline";
}

function ConnectAccountDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>("gmail");
  const [label, setLabel] = useState("");
  const connect = useConnectCommAccount({
    mutation: {
      onSuccess: () => {
        setLabel("");
        setProvider("gmail");
        setOpen(false);
        void qc.invalidateQueries();
      },
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-connect-account">
          <Plug className="mr-1 h-3 w-3" />
          Connect account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a communication account</DialogTitle>
          <DialogDescription>
            Tokens are stored locally and only used by your operator.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label
              htmlFor="provider"
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Provider
            </label>
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as Provider)}
            >
              <SelectTrigger id="provider" data-testid="select-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((opt: { value: string; label: string }) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label
              htmlFor="account-label"
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Account label
            </label>
            <Input
              id="account-label"
              data-testid="input-account-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          {connect.isError ? (
            <ErrorBanner error={connect.error} />
          ) : null}
        </div>
        <DialogFooter>
          <Button
            data-testid="button-connect-submit"
            onClick={() =>
              connect.mutate({ data: { provider, label: label.trim() } })
            }
            disabled={!label.trim() || connect.isPending}
          >
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountsTab() {
  const qc = useQueryClient();
  const accountsQuery = useListCommAccounts({ limit: 50 });
  const accounts = accountsQuery.data?.data.items ?? [];
  const disconnect = useDisconnectCommAccount({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  return (
    <div className="space-y-3">
      {accountsQuery.isError ? (
        <ErrorBanner error={accountsQuery.error} />
      ) : null}
      {accounts.length === 0 ? (
        <EmptyState
          icon={<Plug className="h-8 w-8" />}
          title="No accounts connected"
          description="Connect a Gmail, Outlook, calendar, or Twilio account to begin."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {accounts.map((a) => (
            <Card key={a.id} data-testid={`account-${a.id}`}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{a.label}</CardTitle>
                    <CardDescription className="capitalize">
                      {a.provider.replace("_", " ")} · {a.kind}
                    </CardDescription>
                  </div>
                  <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Connected {formatDate(a.createdAt)}</span>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`button-disconnect-${a.id}`}
                  onClick={() => disconnect.mutate({ id: a.id })}
                  disabled={disconnect.isPending}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Disconnect
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function getSuggestedAction(category: string | null | undefined): string | null {
  if (!category) return null;
  switch (category.toLowerCase()) {
    case "prospect":
      return "Reply within 24h";
    case "customer":
      return "Follow up";
    case "spam":
      return "Unsubscribe";
    default:
      return null;
  }
}

function InboxTab() {
  const messagesQuery = useListEmailMessages({ limit: 50 });
  const messages = messagesQuery.data?.data.items ?? [];

  return (
    <div className="space-y-2">
      {messagesQuery.isError ? (
        <ErrorBanner error={messagesQuery.error} />
      ) : null}
      {messages.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-8 w-8" />}
          title="No messages yet"
          description="Mirror your inbox by ingesting messages from a connected account."
        />
      ) : (
        <div className="divide-y rounded-md border">
          {messages.map((m) => (
            <div
              key={m.id}
              className="flex items-start gap-3 p-3"
              data-testid={`message-${m.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant={statusVariant(m.status)}>{m.status}</Badge>
                  {m.category && (
                    <Badge variant="outline" className="capitalize">
                      {m.category}
                    </Badge>
                  )}
                  <span className="font-medium truncate">{m.subject}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {m.fromAddress} → {m.toAddresses.join(", ")}
                </div>
                <div className="text-xs text-muted-foreground line-clamp-2">
                  {m.snippet || m.body.slice(0, 200)}
                </div>
                {getSuggestedAction(m.category) && (
                  <div className="mt-1 text-xs font-medium text-primary">
                    Suggestion: {getSuggestedAction(m.category)}
                  </div>
                )}
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                {formatDate(m.receivedAt)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DraftsTab() {
  const qc = useQueryClient();
  const accountsQuery = useListCommAccounts({ limit: 50 });
  const emailAccounts =
    accountsQuery.data?.data.items.filter((a) => a.kind === "email") ?? [];
  const draftsQuery = useListEmailDrafts({ limit: 50 });
  const drafts = draftsQuery.data?.data.items ?? [];

  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const create = useCreateEmailDraft({
    mutation: {
      onSuccess: () => {
        setTo("");
        setSubject("");
        setBody("");
        setOpen(false);
        void qc.invalidateQueries();
      },
    },
  });
  const send = useSendEmailDraft({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });
  const deny = useDenyEmailDraft({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" data-testid="button-new-draft">
              <Plus className="mr-1 h-3 w-3" />
              New draft
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New email draft</DialogTitle>
              <DialogDescription>
                Drafts wait for explicit approval before sending.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="draft-account"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Account
                </label>
                <Select value={accountId} onValueChange={setAccountId}>
                  <SelectTrigger id="draft-account" data-testid="select-draft-account">
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
              <div>
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  To (comma-separated)
                </label>
                <Input
                  data-testid="input-draft-to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="alice@example.com, bob@example.com"
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Subject
                </label>
                <Input
                  data-testid="input-draft-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Body
                </label>
                <Textarea
                  data-testid="input-draft-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={6}
                />
              </div>
              {create.isError ? (
                <ErrorBanner error={create.error} />
              ) : null}
            </div>
            <DialogFooter>
              <Button
                data-testid="button-create-draft"
                disabled={
                  !accountId ||
                  !to.trim() ||
                  !subject.trim() ||
                  !body.trim() ||
                  create.isPending
                }
                onClick={() =>
                  create.mutate({
                    data: {
                      accountId,
                      toAddresses: to
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                      subject: subject.trim(),
                      body,
                    },
                  })
                }
              >
                Save draft
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {drafts.length === 0 ? (
        <EmptyState
          icon={<Send className="h-8 w-8" />}
          title="No drafts"
          description="Compose an outbound email — it will wait here for your approval."
        />
      ) : (
        <div className="divide-y rounded-md border">
          {drafts.map((d) => (
            <div
              key={d.id}
              className="flex items-start gap-3 p-3"
              data-testid={`draft-${d.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant={statusVariant(d.decision)}>
                    {d.decision}
                  </Badge>
                  <span className="font-medium truncate">{d.subject}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  → {d.toAddresses.join(", ")}
                </div>
                <div className="text-xs text-muted-foreground line-clamp-2">
                  {d.body.slice(0, 200)}
                </div>
              </div>
              {d.decision === "pending" ? (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    data-testid={`button-send-${d.id}`}
                    onClick={() => send.mutate({ id: d.id })}
                    disabled={send.isPending}
                  >
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    Send
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`button-deny-${d.id}`}
                    onClick={() => deny.mutate({ id: d.id })}
                    disabled={deny.isPending}
                  >
                    <XCircle className="mr-1 h-3 w-3" />
                    Deny
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CalendarTab() {
  const qc = useQueryClient();
  const accountsQuery = useListCommAccounts({ limit: 50 });
  const calAccounts =
    accountsQuery.data?.data.items.filter((a) => a.kind === "calendar") ?? [];
  const eventsQuery = useListCalendarEvents({ limit: 50 });
  const events = eventsQuery.data?.data.items ?? [];

  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  const create = useCreateCalendarEvent({
    mutation: {
      onSuccess: () => {
        setTitle("");
        setStartsAt("");
        setEndsAt("");
        setOpen(false);
        void qc.invalidateQueries();
      },
    },
  });
  const remove = useDeleteCalendarEvent({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" data-testid="button-new-event">
              <Plus className="mr-1 h-3 w-3" />
              New event
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Schedule an event</DialogTitle>
              <DialogDescription>
                Times use your local timezone.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger data-testid="select-event-account">
                  <SelectValue placeholder="Pick a calendar account" />
                </SelectTrigger>
                <SelectContent>
                  {calAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                data-testid="input-event-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Event title"
              />
              <Input
                data-testid="input-event-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
              <Input
                data-testid="input-event-ends"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
              {create.isError ? (
                <ErrorBanner error={create.error} />
              ) : null}
            </div>
            <DialogFooter>
              <Button
                data-testid="button-create-event"
                disabled={
                  !accountId ||
                  !title.trim() ||
                  !startsAt ||
                  !endsAt ||
                  create.isPending
                }
                onClick={() => {
                  const s = new Date(startsAt).getTime();
                  const e = new Date(endsAt).getTime();
                  if (!Number.isFinite(s) || !Number.isFinite(e)) return;
                  create.mutate({
                    data: {
                      accountId,
                      title: title.trim(),
                      startsAt: s,
                      endsAt: e,
                    },
                  });
                }}
              >
                Schedule
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {events.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-8 w-8" />}
          title="No events"
          description="Create or sync a calendar event to see it here."
        />
      ) : (
        <div className="divide-y rounded-md border">
          {events.map((ev) => (
            <div
              key={ev.id}
              className="flex items-start gap-3 p-3"
              data-testid={`event-${ev.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant={statusVariant(ev.status)}>{ev.status}</Badge>
                  <span className="font-medium truncate">{ev.title}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDate(ev.startsAt)} → {formatDate(ev.endsAt)}
                </div>
                {ev.location ? (
                  <div className="text-xs text-muted-foreground">
                    @ {ev.location}
                  </div>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                data-testid={`button-delete-event-${ev.id}`}
                onClick={() => remove.mutate({ id: ev.id })}
                disabled={remove.isPending}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CallsTab() {
  const qc = useQueryClient();
  const accountsQuery = useListCommAccounts({ limit: 50 });
  const voipAccounts =
    accountsQuery.data?.data.items.filter((a) => a.kind === "voip") ?? [];
  const callsQuery = useListVoipCalls({ limit: 50 });
  const calls = callsQuery.data?.data.items ?? [];

  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [toNumber, setToNumber] = useState("");

  const place = usePlaceVoipCall({
    mutation: {
      onSuccess: () => {
        setToNumber("");
        setOpen(false);
        void qc.invalidateQueries();
      },
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" data-testid="button-place-call">
              <PhoneCall className="mr-1 h-3 w-3" />
              Place call
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Place an outbound call</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger data-testid="select-call-account">
                  <SelectValue placeholder="Pick a Twilio account" />
                </SelectTrigger>
                <SelectContent>
                  {voipAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                data-testid="input-call-to"
                value={toNumber}
                onChange={(e) => setToNumber(e.target.value)}
                placeholder="+15551234567"
              />
              {place.isError ? (
                <ErrorBanner error={place.error} />
              ) : null}
            </div>
            <DialogFooter>
              <Button
                data-testid="button-place-call-submit"
                disabled={!accountId || !toNumber.trim() || place.isPending}
                onClick={() =>
                  place.mutate({
                    data: { accountId, toNumber: toNumber.trim() },
                  })
                }
              >
                Call
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {calls.length === 0 ? (
        <EmptyState
          icon={<PhoneCall className="h-8 w-8" />}
          title="No calls yet"
          description="Place an outbound call or wait for an inbound webhook."
        />
      ) : (
        <div className="divide-y rounded-md border">
          {calls.map((c) => (
            <div
              key={c.id}
              className="flex items-start gap-3 p-3"
              data-testid={`call-${c.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                  <span className="font-medium">
                    {c.direction === "outbound" ? "→" : "←"} {c.toNumber}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  from {c.fromNumber}
                  {c.durationSeconds ? ` · ${c.durationSeconds}s` : ""}
                </div>
                {c.summary ? (
                  <div className="text-xs text-muted-foreground line-clamp-2 mt-1">
                    {c.summary}
                  </div>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                {formatDate(c.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContactsTab() {
  const qc = useQueryClient();
  const contactsQuery = useListContacts({ limit: 100 });
  const contacts = contactsQuery.data?.data.items ?? [];

  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");

  const create = useCreateContact({
    mutation: {
      onSuccess: () => {
        setDisplayName("");
        setEmail("");
        setPhone("");
        setCompany("");
        setOpen(false);
        void qc.invalidateQueries();
      },
    },
  });
  const remove = useDeleteContact({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" data-testid="button-new-contact">
              <Plus className="mr-1 h-3 w-3" />
              New contact
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New contact</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Input
                data-testid="input-contact-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display name"
              />
              <Input
                data-testid="input-contact-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
              />
              <Input
                data-testid="input-contact-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+15550001111"
              />
              <Input
                data-testid="input-contact-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Company"
              />
              {create.isError ? (
                <ErrorBanner error={create.error} />
              ) : null}
            </div>
            <DialogFooter>
              <Button
                data-testid="button-create-contact"
                disabled={!displayName.trim() || create.isPending}
                onClick={() =>
                  create.mutate({
                    data: {
                      displayName: displayName.trim(),
                      ...(email.trim() ? { email: email.trim() } : {}),
                      ...(phone.trim() ? { phone: phone.trim() } : {}),
                      ...(company.trim() ? { company: company.trim() } : {}),
                    },
                  })
                }
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {contacts.length === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="No contacts"
          description="Add a contact to start tracking interactions."
        />
      ) : (
        <div className="divide-y rounded-md border">
          {contacts.map((c) => (
            <div
              key={c.id}
              className="flex items-start gap-3 p-3"
              data-testid={`contact-${c.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{c.displayName}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {[c.email, c.phone, c.company].filter(Boolean).join(" · ") ||
                    "—"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Last interaction {formatDate(c.lastInteractionAt)}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                data-testid={`button-delete-contact-${c.id}`}
                onClick={() => remove.mutate({ id: c.id })}
                disabled={remove.isPending}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OutreachTab() {
  const qc = useQueryClient();
  const seqQuery = useListOutreachSequences({ limit: 50 });
  const sequences = seqQuery.data?.data.items ?? [];
  const enrolQuery = useListOutreachEnrolments({ limit: 100 });
  const enrolments = enrolQuery.data?.data.items ?? [];

  const run = useRunOutreachSteps({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const setStatus = useSetOutreachSequenceStatus({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium">Sequences</h3>
          <div className="flex gap-2">
            <OutreachSequenceDialog />
            <Button
              size="sm"
              onClick={() => run.mutate({ data: {} })}
              disabled={run.isPending}
            >
              <Workflow className="mr-1 h-3 w-3" />
              Run due steps
            </Button>
          </div>
        </div>

        {run.data ? (
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            Scanned {run.data.data.enrolmentsScanned} · Sent{" "}
            {run.data.data.stepsSent} · Replies {run.data.data.repliesDetected} ·
            Completed {run.data.data.completed}
          </div>
        ) : null}

        {sequences.length === 0 ? (
          <EmptyState
            icon={<Workflow className="h-8 w-8" />}
            title="No sequences"
            description="Outreach sequences send drafts on a delay and stop on reply."
          />
        ) : (
          <div className="divide-y rounded-md border">
            {sequences.map((s) => (
              <div
                key={s.id}
                className="flex items-start gap-3 p-3"
                data-testid={`sequence-${s.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                    <span className="font-medium truncate">{s.name}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.steps.length} step{s.steps.length === 1 ? "" : "s"}
                    {s.description ? ` · ${s.description}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(s.createdAt)}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0"
                    onClick={() =>
                      setStatus.mutate({
                        id: s.id,
                        data: {
                          status: s.status === "active" ? "paused" : "active",
                        },
                      })
                    }
                  >
                    {s.status === "active" ? "Pause" : "Start"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3 pt-6 border-t">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium">Active Enrolments</h3>
          <EnrolContactDialog />
        </div>

        {enrolments.length === 0 ? (
          <EmptyState
            icon={<Users className="h-8 w-8" />}
            title="No active enrolments"
            description="Enrol a contact into a sequence to begin automation."
          />
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="text-left p-3 font-medium">Contact</th>
                  <th className="text-left p-3 font-medium">Sequence</th>
                  <th className="text-left p-3 font-medium">Status</th>
                  <th className="text-left p-3 font-medium">Next Send</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {enrolments.map((e) => (
                  <tr key={e.id} data-testid={`enrolment-${e.id}`}>
                    <td className="p-3">
                      <div className="font-medium text-xs font-mono">{e.contactId}</div>
                    </td>
                    <td className="p-3 text-muted-foreground text-xs font-mono">{e.sequenceId}</td>
                    <td className="p-3">
                      <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {e.status === "active" ? formatDate(e.nextSendAt) : "—"}
                    </td>
                    <td className="p-3 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={async () => {
                          if (!confirm("Are you sure you want to cancel this enrolment?")) return;
                          await fetch(`/api/comm/outreach/enrolments/${e.id}`, { method: "DELETE" });
                          void qc.invalidateQueries();
                        }}
                      >
                        Cancel
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CommunicationsPage() {
  const tabs = useMemo(
    () => [
      { value: "accounts", label: "Accounts", icon: Plug, content: <AccountsTab /> },
      { value: "inbox", label: "Inbox", icon: Inbox, content: <InboxTab /> },
      { value: "drafts", label: "Drafts", icon: Send, content: <DraftsTab /> },
      {
        value: "calendar",
        label: "Calendar",
        icon: CalendarDays,
        content: <CalendarTab />,
      },
      { value: "calls", label: "Calls", icon: PhoneCall, content: <CallsTab /> },
      { value: "contacts", label: "Contacts", icon: Users, content: <ContactsTab /> },
      {
        value: "outreach",
        label: "Outreach",
        icon: Workflow,
        content: <OutreachTab />,
      },
    ],
    [],
  );

  return (
    <OperatorLayout
      title="Communications"
      description="Connected accounts, inbox triage, drafts, calendar, calls, and contacts."
      actions={<ConnectAccountDialog />}
    >
      <div className="p-6">
        <Tabs defaultValue="accounts" className="space-y-4">
          <TabsList>
            {tabs.map((t) => {
              const Icon = t.icon;
              return (
                <TabsTrigger
                  key={t.value}
                  value={t.value}
                  data-testid={`tab-${t.value}`}
                >
                  <Icon className="mr-1 h-3 w-3" />
                  {t.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t.value} value={t.value}>
              {t.content}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </OperatorLayout>
  );
}
