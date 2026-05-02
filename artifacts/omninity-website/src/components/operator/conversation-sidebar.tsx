import { useEffect, useMemo, useState } from "react";
import {
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  Trash2,
  Plus,
  Search,
  Download,
  Pencil,
} from "lucide-react";
import {
  useListConversations,
  useUpdateConversation,
  useDeleteConversation,
  useSearchConversations,
  exportConversation,
  getConversation,
  type Conversation,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface ConversationSidebarProps {
  activeId: string | null;
  onSelect: (c: Conversation | null) => void;
  onNew: () => void;
}

type FilterMode = "recent" | "archived" | "agent" | "desktop";

export function ConversationSidebar({
  activeId,
  onSelect,
  onNew,
}: ConversationSidebarProps) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterMode>("recent");
  const [searchOpen, setSearchOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const listQuery = useListConversations({
    limit: 50,
    ...(filter === "archived" ? { archivedOnly: true } : {}),
    ...(filter === "agent" ? { agentOnly: true } : {}),
    ...(filter === "desktop" ? { desktopOnly: true } : {}),
  });
  const items = listQuery.data?.data.items ?? [];

  const update = useUpdateConversation({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["/conversations"] });
      },
    },
  });
  const del = useDeleteConversation({
    mutation: {
      onSuccess: (_resp, vars) => {
        if (vars.id === activeId) onSelect(null);
        void qc.invalidateQueries({ queryKey: ["/conversations"] });
      },
    },
  });

  const pinned = useMemo(() => items.filter((c) => c.pinned), [items]);
  const others = useMemo(() => items.filter((c) => !c.pinned), [items]);

  // Cmd/Ctrl-K opens search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      className="hidden md:flex w-64 shrink-0 flex-col border-r border-border bg-muted/10"
      data-testid="conversation-sidebar"
    >
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Button
          size="sm"
          className="flex-1"
          onClick={onNew}
          data-testid="button-new-thread"
        >
          <Plus className="mr-1 h-3 w-3" /> New
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          aria-label="Search conversations"
          onClick={() => setSearchOpen(true)}
          data-testid="button-search-conversations"
        >
          <Search className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <FilterChip
          active={filter === "recent"}
          label="Recent"
          onClick={() => setFilter("recent")}
        />
        <FilterChip
          active={filter === "agent"}
          label="Agent"
          onClick={() => setFilter("agent")}
        />
        <FilterChip
          active={filter === "desktop"}
          label="Desktop"
          onClick={() => setFilter("desktop")}
        />
        <FilterChip
          active={filter === "archived"}
          label="Archived"
          onClick={() => setFilter("archived")}
        />
        <span
          className="ml-auto text-[10px] normal-case text-muted-foreground/80"
          data-testid="conversation-count"
        >
          {items.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listQuery.isLoading ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {filter === "archived"
              ? "Nothing archived yet."
              : filter === "agent"
                ? "No agent runs yet."
                : filter === "desktop"
                  ? "No desktop sessions yet."
                  : "No conversations yet."}
          </p>
        ) : (
          <>
            {pinned.length > 0 && filter === "recent" ? (
              <>
                <p className="px-3 pt-1 text-[10px] uppercase text-muted-foreground/70">
                  Pinned
                </p>
                {pinned.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === activeId}
                    onSelect={() => onSelect(c)}
                    onPin={() =>
                      update.mutate({
                        id: c.id,
                        data: { pinned: !c.pinned },
                      })
                    }
                    onArchive={() =>
                      update.mutate({
                        id: c.id,
                        data: { archived: !c.archived },
                      })
                    }
                    onRename={() => {
                      setRenameValue(c.title);
                      setRenameTarget(c);
                    }}
                    onDelete={() => setDeleteTarget(c)}
                  />
                ))}
                <div className="my-1 h-px bg-border/50" />
              </>
            ) : null}
            {others.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={c.id === activeId}
                onSelect={() => onSelect(c)}
                onPin={() =>
                  update.mutate({ id: c.id, data: { pinned: !c.pinned } })
                }
                onArchive={() =>
                  update.mutate({
                    id: c.id,
                    data: { archived: !c.archived },
                  })
                }
                onRename={() => {
                  setRenameValue(c.title);
                  setRenameTarget(c);
                }}
                onDelete={() => setDeleteTarget(c)}
              />
            ))}
          </>
        )}
      </div>

      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onJump={async (conversationId) => {
          // Jump targets may live outside the currently filtered view (e.g.
          // hits in archived threads while we're viewing Recent), so always
          // fetch the conversation directly so restoration works regardless
          // of which filter chip is active.
          const found = items.find((c) => c.id === conversationId);
          if (found) {
            onSelect(found);
          } else {
            try {
              const resp = await getConversation(conversationId);
              onSelect(resp.data);
            } catch {
              /* swallow — sidebar stays put if hit got deleted in the meantime */
            }
          }
          setSearchOpen(false);
        }}
      />

      <RenameDialog
        target={renameTarget}
        value={renameValue}
        onChange={setRenameValue}
        onClose={() => setRenameTarget(null)}
        onSave={() => {
          if (!renameTarget) return;
          update.mutate(
            { id: renameTarget.id, data: { title: renameValue.trim() || renameTarget.title } },
            { onSuccess: () => setRenameTarget(null) },
          );
        }}
      />

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes “{deleteTarget?.title}” along with all of
              its messages and any agent runs that belong to it. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteTarget) return;
                del.mutate(
                  { id: deleteTarget.id },
                  { onSettled: () => setDeleteTarget(null) },
                );
              }}
              data-testid="confirm-delete-conversation"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide hover-elevate",
        active
          ? "border-foreground/40 bg-foreground/10 text-foreground"
          : "border-transparent text-muted-foreground",
      )}
      data-testid={`filter-${label.toLowerCase()}`}
    >
      {label}
    </button>
  );
}

interface ConversationRowProps {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onPin: () => void;
  onArchive: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function ConversationRow({
  conversation: c,
  active,
  onSelect,
  onPin,
  onArchive,
  onRename,
  onDelete,
}: ConversationRowProps) {
  const downloadExport = async (format: "markdown" | "json" | "pdf") => {
    const resp = await exportConversation(c.id, { format });
    const payload = resp.data;
    let blob: Blob;
    if (payload.encoding === "base64") {
      const binary = atob(payload.body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: payload.contentType });
    } else {
      blob = new Blob([payload.body], { type: payload.contentType });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = payload.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className={cn(
        "group flex items-start gap-1 px-2 py-2 text-sm hover-elevate",
        active && "bg-muted/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex-1 min-w-0 text-left"
        data-testid={`row-conversation-${c.id}`}
      >
        <div className="flex items-center gap-1">
          {c.pinned ? (
            <Pin className="h-3 w-3 shrink-0 text-amber-500" />
          ) : null}
          <span className="truncate text-xs font-medium">{c.title}</span>
        </div>
        {c.lastMessagePreview ? (
          <p className="truncate text-[11px] text-muted-foreground">
            {c.lastMessagePreview}
          </p>
        ) : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100"
            aria-label="Conversation actions"
            data-testid={`menu-conversation-${c.id}`}
          >
            <span aria-hidden>⋯</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onPin}>
            {c.pinned ? (
              <>
                <PinOff className="mr-2 h-3.5 w-3.5" /> Unpin
              </>
            ) : (
              <>
                <Pin className="mr-2 h-3.5 w-3.5" /> Pin
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onArchive}>
            {c.archived ? (
              <>
                <ArchiveRestore className="mr-2 h-3.5 w-3.5" /> Unarchive
              </>
            ) : (
              <>
                <Archive className="mr-2 h-3.5 w-3.5" /> Archive
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void downloadExport("markdown")}>
            <Download className="mr-2 h-3.5 w-3.5" /> Export Markdown
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void downloadExport("json")}>
            <Download className="mr-2 h-3.5 w-3.5" /> Export JSON
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void downloadExport("pdf")}>
            <Download className="mr-2 h-3.5 w-3.5" /> Export PDF
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RenameDialog({
  target,
  value,
  onChange,
  onClose,
  onSave,
}: {
  target: Conversation | null;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>
            Pick a short title that helps you find this thread later.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={200}
          autoFocus
          data-testid="input-rename-conversation"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSave();
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} data-testid="button-confirm-rename">
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SearchDialog({
  open,
  onOpenChange,
  onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJump: (conversationId: string) => void;
}) {
  const [q, setQ] = useState("");
  const trimmed = q.trim();
  const search = useSearchConversations(
    { q: trimmed, limit: 25 },
    { query: { enabled: open && trimmed.length >= 2 } as never },
  );
  const hits = search.data?.data.items ?? [];

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Search conversations</DialogTitle>
          <DialogDescription>
            Full-text search across messages and agent runs. ⌘K to reopen.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search messages…"
          autoFocus
          data-testid="input-search-conversations"
        />
        <div className="max-h-72 overflow-y-auto">
          {trimmed.length < 2 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Type at least 2 characters.
            </p>
          ) : search.isFetching ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Searching…
            </p>
          ) : hits.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No matches.
            </p>
          ) : (
            <ul className="space-y-1">
              {hits.map((h) => (
                <li key={`${h.matchType}-${h.matchId}`}>
                  <button
                    type="button"
                    className="w-full rounded-md p-2 text-left hover-elevate"
                    onClick={() => onJump(h.conversationId)}
                    data-testid={`search-hit-${h.matchId}`}
                  >
                    <div className="flex items-center gap-2 text-xs font-medium">
                      <span className="truncate">{h.conversationTitle}</span>
                      <span className="text-[10px] uppercase text-muted-foreground">
                        {h.matchType}
                        {h.role ? ` · ${h.role}` : ""}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                      {h.preview}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
