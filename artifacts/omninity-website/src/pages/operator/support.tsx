/**
 * Operator support page — in-app support panel (Task #34).
 *
 * Lets the user browse their open tickets, file a new one, and reply on
 * an existing one. Diagnostic info (OP version, OS) is stamped on
 * submission so the OP team can triage without pestering the user.
 */
import { useEffect, useMemo, useState } from "react";
import { LifeBuoy, MessageSquare, Send, ShieldAlert } from "lucide-react";

import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import {
  appendMessage,
  createTicket,
  getTicket,
  listTickets,
  type SupportTicket,
  type SupportTicketEvent,
} from "@/lib/support-api";

const CATEGORY_OPTIONS = [
  { value: "general", label: "General question" },
  { value: "bug", label: "Bug report" },
  { value: "billing", label: "Billing & payments" },
  { value: "account", label: "Account access" },
  { value: "security", label: "Security concern" },
  { value: "feature-question", label: "Feature question" },
  { value: "other", label: "Other" },
];

const PRIORITY_TONE: Record<string, string> = {
  urgent: "bg-red-500/15 text-red-600 dark:text-red-400",
  high: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  normal: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  low: "bg-muted text-muted-foreground",
};

const STATUS_TONE: Record<string, string> = {
  open: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  in_progress: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  waiting_user: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  resolved: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  closed: "bg-muted text-muted-foreground",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function detectOs(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iOS";
  return "Unknown";
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeEvents, setActiveEvents] = useState<SupportTicketEvent[]>([]);
  const [reply, setReply] = useState("");

  // New ticket form state.
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newCategory, setNewCategory] = useState("general");
  const [submitting, setSubmitting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const items = await listTickets();
      setTickets(items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!activeId) return;
    void getTicket(activeId).then((r) => setActiveEvents(r.events));
  }, [activeId, tickets]);

  const activeTicket = useMemo(
    () => tickets.find((t) => t.id === activeId) ?? null,
    [tickets, activeId],
  );

  const handleSubmit = async () => {
    if (!newSubject.trim() || !newBody.trim() || !newEmail.trim()) {
      setError("Please fill in subject, message and email.");
      return;
    }
    setSubmitting(true);
    try {
      const ticket = await createTicket({
        subject: newSubject,
        body: newBody,
        userEmail: newEmail,
        category: newCategory,
        opVersion: "1.0.0-web",
        osInfo: detectOs(),
      });
      setNewSubject("");
      setNewBody("");
      await refresh();
      setActiveId(ticket.id);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReply = async () => {
    if (!activeId || !reply.trim()) return;
    try {
      await appendMessage(activeId, reply);
      setReply("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <OperatorLayout
      title="Support"
      description="Open a ticket or follow up on a previous conversation"
    >
      <div
        className="mx-auto grid w-full max-w-6xl gap-6 p-6 lg:grid-cols-[1fr_1fr]"
        data-testid="support-page"
      >
        {error ? <ErrorBanner error={error} /> : null}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LifeBuoy className="h-5 w-5" />
              Submit a ticket
            </CardTitle>
            <CardDescription>
              Security and billing tickets are auto-escalated to the OP team
              support queue.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="support-email">Reply email</Label>
              <Input
                id="support-email"
                type="email"
                placeholder="you@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                data-testid="support-email-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-category">Category</Label>
              <Select value={newCategory} onValueChange={setNewCategory}>
                <SelectTrigger
                  id="support-category"
                  data-testid="support-category-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-subject">Subject</Label>
              <Input
                id="support-subject"
                placeholder="Briefly describe the issue"
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                data-testid="support-subject-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-body">Details</Label>
              <Textarea
                id="support-body"
                rows={6}
                placeholder="What happened? What did you expect?"
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                data-testid="support-body-input"
              />
            </div>
            <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
              <ShieldAlert className="mr-1 inline h-3 w-3" />
              We attach a sanitised diagnostic snapshot (OP version, OS) — no
              file contents, no API keys, no message bodies.
            </div>
            <Button
              className="w-full"
              onClick={handleSubmit}
              disabled={submitting}
              data-testid="support-submit-button"
            >
              {submitting ? "Submitting…" : "Submit ticket"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Your tickets
            </CardTitle>
            <CardDescription>
              {tickets.length === 0
                ? "Nothing here yet."
                : `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : tickets.length === 0 ? (
              <EmptyState
                icon={<LifeBuoy className="h-8 w-8" />}
                title="No tickets yet"
                description="Submit a ticket on the left to get help from the OP team."
              />
            ) : (
              tickets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveId(t.id)}
                  className={`w-full rounded-md border p-3 text-left transition hover:border-primary/40 ${
                    activeId === t.id ? "border-primary/60 bg-muted/40" : ""
                  }`}
                  data-testid={`support-ticket-${t.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">{t.subject}</div>
                    <div className="flex flex-shrink-0 gap-1">
                      <Badge
                        className={PRIORITY_TONE[t.priority] ?? PRIORITY_TONE.normal}
                      >
                        {t.priority}
                      </Badge>
                      <Badge className={STATUS_TONE[t.status] ?? STATUS_TONE.open}>
                        {t.status.replace("_", " ")}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatTime(t.createdAt)}
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {activeTicket ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{activeTicket.subject}</CardTitle>
              <CardDescription>
                {activeTicket.category} · opened {formatTime(activeTicket.createdAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {activeEvents.map((ev) => (
                  <div
                    key={ev.id}
                    className={`rounded-md border p-3 ${
                      ev.sender === "op"
                        ? "border-primary/30 bg-primary/5"
                        : ev.sender === "system"
                          ? "border-amber-500/30 bg-amber-500/5"
                          : "bg-muted/30"
                    }`}
                  >
                    <div className="text-xs font-medium uppercase text-muted-foreground">
                      {ev.sender === "op"
                        ? `OP team${ev.senderLabel ? ` · ${ev.senderLabel}` : ""}`
                        : ev.sender === "system"
                          ? "System"
                          : ev.senderLabel || "You"}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-sm">
                      {ev.body}
                    </div>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {formatTime(ev.createdAt)}
                    </div>
                  </div>
                ))}
              </div>

              {activeTicket.status !== "closed" &&
              activeTicket.status !== "resolved" ? (
                <div className="space-y-2">
                  <Label htmlFor="support-reply">Reply</Label>
                  <Textarea
                    id="support-reply"
                    rows={4}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="Add a follow-up message…"
                    data-testid="support-reply-input"
                  />
                  <Button
                    onClick={handleReply}
                    disabled={!reply.trim()}
                    data-testid="support-reply-button"
                  >
                    <Send className="mr-2 h-4 w-4" />
                    Send reply
                  </Button>
                </div>
              ) : (
                <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  This ticket is {activeTicket.status}. Open a new ticket if
                  you need more help.
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </OperatorLayout>
  );
}
