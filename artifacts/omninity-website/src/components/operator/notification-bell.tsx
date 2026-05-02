import { useState } from "react";
import { Link } from "wouter";
import { Bell, BellOff, Check, CheckCheck, Trash2, Settings as SettingsIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNotifications,
  useGetNotificationUnreadCount,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useClearNotifications,
  useGetNotificationPreferences,
  useUpdateNotificationPreferences,
  getListNotificationsQueryKey,
  getGetNotificationUnreadCountQueryKey,
  getGetNotificationPreferencesQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const SEVERITY_DOT: Record<string, string> = {
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-destructive",
};

const CATEGORIES = [
  { key: "task", label: "Task updates" },
  { key: "approval", label: "Approval requests" },
  { key: "skill", label: "Skill executions" },
  { key: "error", label: "Errors" },
  { key: "system", label: "System" },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]["key"];

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const countQuery = useGetNotificationUnreadCount({
    query: { refetchInterval: 30_000 } as never,
  });
  const listQuery = useListNotifications(
    { limit: 30 },
    { query: { enabled: open } as never },
  );
  const prefsQuery = useGetNotificationPreferences({
    query: { enabled: open } as never,
  });

  const markOne = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const clearAll = useClearNotifications();
  const updatePrefs = useUpdateNotificationPreferences();

  const unreadCount = countQuery.data?.data.count ?? 0;
  const items = listQuery.data?.data.items ?? [];
  const prefs = prefsQuery.data?.data.preferences;

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getListNotificationsQueryKey() }),
      qc.invalidateQueries({ queryKey: getGetNotificationUnreadCountQueryKey() }),
    ]);
  };

  const onMarkOne = async (id: string) => {
    await markOne.mutateAsync({ id });
    await refreshAll();
  };
  const onMarkAll = async () => {
    await markAll.mutateAsync();
    await refreshAll();
  };
  const onClear = async () => {
    if (!window.confirm("Delete every notification? This cannot be undone.")) return;
    await clearAll.mutateAsync();
    await refreshAll();
  };
  const onTogglePref = async (
    cat: CategoryKey,
    field: "inApp" | "os",
    next: boolean,
  ) => {
    if (!prefs) return;
    const current = prefs[cat];
    await updatePrefs.mutateAsync({
      data: {
        [cat]: { ...current, [field]: next },
      },
    });
    await qc.invalidateQueries({ queryKey: getGetNotificationPreferencesQueryKey() });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label={`Notifications (${unreadCount} unread)`}
          data-testid="button-notification-bell"
          className="relative"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 ? (
            <span
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground"
              data-testid="badge-unread-count"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[380px] p-0"
        data-testid="popover-notifications"
      >
        <Tabs defaultValue="inbox">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <TabsList className="h-8">
              <TabsTrigger value="inbox" className="text-xs" data-testid="tab-inbox">
                Inbox
                {unreadCount > 0 ? (
                  <Badge variant="secondary" className="ml-2 h-4 px-1 text-[10px]">
                    {unreadCount}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="prefs" className="text-xs" data-testid="tab-prefs">
                <SettingsIcon className="mr-1 h-3 w-3" />
                Preferences
              </TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={onMarkAll}
                disabled={markAll.isPending || unreadCount === 0}
                data-testid="button-mark-all-read"
                title="Mark all as read"
              >
                <CheckCheck className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={onClear}
                disabled={clearAll.isPending || items.length === 0}
                data-testid="button-clear-notifications"
                title="Clear all"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>

          <TabsContent value="inbox" className="m-0">
            <ScrollArea className="h-[420px]">
              {listQuery.isLoading ? (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  Loading…
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
                  <BellOff className="h-6 w-6" />
                  <p className="text-sm">You're all caught up.</p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((n) => (
                    <li
                      key={n.id}
                      className={cn(
                        "group flex items-start gap-2 px-3 py-3 text-sm",
                        !n.read && "bg-muted/40",
                      )}
                      data-testid={`notification-${n.id}`}
                    >
                      <span
                        className={cn(
                          "mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full",
                          SEVERITY_DOT[n.severity] ?? "bg-muted-foreground",
                        )}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="truncate font-medium">{n.title}</p>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {formatRelative(n.createdAt)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                          {n.body}
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="h-4 px-1 text-[10px] capitalize"
                          >
                            {n.category}
                          </Badge>
                          {n.actionHref ? (
                            <Link
                              href={n.actionHref}
                              data-testid={`link-action-${n.id}`}
                              onClick={() => setOpen(false)}
                              className="text-[11px] text-primary underline-offset-2 hover:underline"
                            >
                              {n.actionLabel ?? "Open"}
                            </Link>
                          ) : null}
                          {!n.read ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="ml-auto h-5 px-1 text-[10px]"
                              onClick={() => onMarkOne(n.id)}
                              data-testid={`button-mark-read-${n.id}`}
                            >
                              <Check className="mr-0.5 h-3 w-3" />
                              Read
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
            <div className="border-t border-border p-2 text-center">
              <Link
                href="/activity"
                onClick={() => setOpen(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
                data-testid="link-view-activity"
              >
                View activity centre →
              </Link>
            </div>
          </TabsContent>

          <TabsContent value="prefs" className="m-0 p-3">
            <p className="mb-3 text-xs text-muted-foreground">
              Choose which categories surface in the bell and trigger native OS
              notifications when the desktop shell is running.
            </p>
            {prefsQuery.isLoading || !prefs ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (
              <ul className="space-y-3">
                {CATEGORIES.map((c) => {
                  const p = prefs[c.key];
                  return (
                    <li
                      key={c.key}
                      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                      data-testid={`pref-row-${c.key}`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{c.label}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {p.inApp ? "In-app on" : "In-app off"} ·{" "}
                          {p.os ? "OS on" : "OS off"}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          App
                          <Switch
                            checked={p.inApp}
                            onCheckedChange={(v) => onTogglePref(c.key, "inApp", v)}
                            data-testid={`switch-${c.key}-inapp`}
                          />
                        </label>
                        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          OS
                          <Switch
                            checked={p.os}
                            onCheckedChange={(v) => onTogglePref(c.key, "os", v)}
                            data-testid={`switch-${c.key}-os`}
                          />
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString();
}
