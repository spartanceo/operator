/**
 * Public feature request board (Task #34).
 *
 * Anyone can browse the community roadmap, file a new request, and
 * upvote what's already there. The upvote is also the email
 * subscription — the OP team broadcasts when status changes.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowUp, Lightbulb, Plus } from "lucide-react";

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
  Dialog,
  DialogContent,
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
import {
  createFeatureRequest,
  listFeatureRequests,
  voteOn,
  type FeatureRequest,
} from "@/lib/support-api";

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "under_review", label: "Under review" },
  { value: "under_consideration", label: "Considering" },
  { value: "planned", label: "Planned" },
  { value: "shipped", label: "Shipped" },
  { value: "wont_build", label: "Won't build" },
];

const STATUS_TONE: Record<string, string> = {
  under_review: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  under_consideration: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  planned: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  shipped: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  wont_build: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge className={STATUS_TONE[status] ?? STATUS_TONE.under_review}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

export default function FeatureRequestsPage() {
  const [items, setItems] = useState<FeatureRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");

  // New request form.
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Voting state — track which requests this browser has upvoted in
  // this session so we can show the "Voted" affordance.
  const [voted, setVoted] = useState<Record<string, boolean>>({});
  const [voteEmail, setVoteEmail] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const opts = statusFilter === "all" ? {} : { status: statusFilter };
      const list = await listFeatureRequests(opts);
      setItems(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [statusFilter]);

  const sorted = useMemo(
    () => [...items].sort((a, b) => b.upvoteCount - a.upvoteCount),
    [items],
  );

  const handleCreate = async () => {
    if (!title.trim() || !email.trim()) {
      setError("Title and email are required.");
      return;
    }
    setSubmitting(true);
    try {
      await createFeatureRequest({
        title,
        description,
        submitterEmail: email,
      });
      setTitle("");
      setDescription("");
      setOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleVote = async (id: string) => {
    let email = voteEmail.trim();
    if (!email) {
      const prompted = window.prompt(
        "Enter your email to upvote and subscribe to status updates:",
      );
      if (!prompted) return;
      email = prompted.trim();
      setVoteEmail(email);
    }
    try {
      const result = await voteOn({ id, voterEmail: email });
      setVoted((v) => ({ ...v, [id]: true }));
      setItems((curr) =>
        curr.map((it) =>
          it.id === id ? { ...it, upvoteCount: result.upvoteCount } : it,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main
      className="mx-auto w-full max-w-5xl space-y-6 p-6"
      data-testid="feature-requests-page"
    >
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Community Roadmap
          </h1>
          <p className="text-muted-foreground">
            Vote for what we should build next. Upvotes subscribe you to
            status updates.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="feature-requests-new-button">
              <Plus className="mr-2 h-4 w-4" />
              New request
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Submit a feature request</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="fr-email">Your email</Label>
                <Input
                  id="fr-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  data-testid="feature-request-email-input"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fr-title">Title</Label>
                <Input
                  id="fr-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What should we build?"
                  data-testid="feature-request-title-input"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fr-desc">Details</Label>
                <Textarea
                  id="fr-desc"
                  rows={5}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Why does this matter? Who is it for?"
                  data-testid="feature-request-description-input"
                />
              </div>
              <Button
                onClick={handleCreate}
                disabled={submitting}
                className="w-full"
                data-testid="feature-request-submit-button"
              >
                {submitting ? "Submitting…" : "Submit"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </header>

      {error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="feature-requests-error"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Label htmlFor="fr-filter">Filter</Label>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger
            id="fr-filter"
            className="w-48"
            data-testid="feature-requests-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading roadmap…</p>
        ) : sorted.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12">
              <Lightbulb className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No requests yet — be the first to suggest something!
              </p>
            </CardContent>
          </Card>
        ) : (
          sorted.map((fr) => (
            <Card key={fr.id} data-testid={`feature-request-${fr.slug}`}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">{fr.title}</CardTitle>
                    <CardDescription className="mt-1 flex flex-wrap items-center gap-2">
                      <StatusBadge status={fr.status} />
                      <span className="text-xs">{fr.category}</span>
                    </CardDescription>
                  </div>
                  <Button
                    variant={voted[fr.id] ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => handleVote(fr.id)}
                    data-testid={`feature-request-vote-${fr.slug}`}
                  >
                    <ArrowUp className="mr-1 h-4 w-4" />
                    {fr.upvoteCount}
                  </Button>
                </div>
              </CardHeader>
              {fr.description || fr.statusNote ? (
                <CardContent>
                  {fr.description ? (
                    <p className="text-sm text-muted-foreground">
                      {fr.description}
                    </p>
                  ) : null}
                  {fr.statusNote ? (
                    <p className="mt-2 rounded-md bg-muted/40 p-2 text-xs italic text-muted-foreground">
                      OP team note: {fr.statusNote}
                    </p>
                  ) : null}
                </CardContent>
              ) : null}
            </Card>
          ))
        )}
      </div>
    </main>
  );
}
