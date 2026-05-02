import { Link } from "wouter";
import { Check, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHelp } from "./help-context";
import { CHECKLIST_ITEMS } from "./help-content";

/**
 * "Getting started" checklist. Shown in the operator sidebar until the
 * user either completes every item or dismisses the strip explicitly.
 */
export function OnboardingChecklist() {
  const {
    isChecklistComplete,
    completeChecklistItem,
    isChecklistDismissed,
    dismissChecklist,
  } = useHelp();

  const completedCount = CHECKLIST_ITEMS.filter((i) =>
    isChecklistComplete(i.id),
  ).length;
  const total = CHECKLIST_ITEMS.length;
  const allDone = completedCount === total;

  // Once complete OR explicitly dismissed, the checklist disappears.
  if (allDone || isChecklistDismissed) return null;

  const pct = Math.round((completedCount / total) * 100);

  return (
    <section
      className="mt-3 rounded-md border border-sidebar-border bg-sidebar-accent/30 p-3"
      data-testid="onboarding-checklist"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-sidebar-foreground">
            Getting started
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {completedCount} of {total} done · {pct}%
          </p>
        </div>
        <button
          type="button"
          onClick={dismissChecklist}
          aria-label="Dismiss checklist"
          data-testid="onboarding-checklist-dismiss"
          className="hover-elevate -mr-1 -mt-1 rounded-md p-1 text-muted-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="mt-2 h-1 overflow-hidden rounded-full bg-sidebar-border">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="mt-3 space-y-1">
        {CHECKLIST_ITEMS.map((item) => {
          const done = isChecklistComplete(item.id);
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                onClick={() => completeChecklistItem(item.id)}
                data-testid={`onboarding-checklist-${item.id}`}
                className={cn(
                  "hover-elevate active-elevate-2 group flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] transition-colors",
                  done
                    ? "text-muted-foreground"
                    : "text-sidebar-foreground",
                )}
              >
                <span
                  className={cn(
                    "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    done
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-sidebar-border bg-background text-transparent",
                  )}
                >
                  <Check className="h-2.5 w-2.5" />
                </span>
                <Icon
                  className={cn(
                    "h-3 w-3",
                    done ? "text-muted-foreground" : "text-primary/80",
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    done && "line-through opacity-70",
                  )}
                >
                  {item.title}
                </span>
                <ChevronRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
