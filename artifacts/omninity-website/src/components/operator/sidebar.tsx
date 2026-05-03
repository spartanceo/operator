import { Link, useLocation } from "wouter";
import {
  MessageSquare,
  Bot,
  Wrench,
  Shield,
  Brain,
  Library,
  Inbox,
  Settings,
  Sparkles,
  ArrowLeft,
  Monitor,
  Image as ImageIcon,
  Activity,
  ShieldCheck,
  Undo2,
  ListTodo,
  LayoutTemplate,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/brand/wordmark";
import { OnboardingChecklist } from "@/components/help";

interface NavItem {
  href: string;
  label: string;
  icon: typeof MessageSquare;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/desktop", label: "Desktop", icon: Monitor },
  { href: "/tools", label: "Tools", icon: Wrench },
  { href: "/media", label: "Media", icon: ImageIcon },
  { href: "/privacy", label: "Privacy", icon: Shield },
  { href: "/memory", label: "Memory", icon: Brain },
  { href: "/knowledge", label: "Knowledge", icon: Library },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/communications", label: "Communications", icon: Inbox },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/undo", label: "Undo", icon: Undo2 },
  { href: "/queue", label: "Tasks", icon: ListTodo },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function OperatorSidebar() {
  const [location] = useLocation();

  return (
    <aside
      className="hidden lg:flex w-60 shrink-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground"
      aria-label="Operator navigation"
    >
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <Link
          href="/chat"
          data-testid="sidebar-wordmark"
          className="flex items-center gap-2"
        >
          <Wordmark size="md" />
        </Link>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active =
            location === item.href || location.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={`nav-${item.label.toLowerCase()}`}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
                "hover-elevate active-elevate-2 transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          );
        })}

        <OnboardingChecklist />
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <Link
          href="/"
          data-testid="link-back-to-marketing"
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-xs",
            "text-muted-foreground hover-elevate active-elevate-2",
          )}
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to website
        </Link>
      </div>
    </aside>
  );
}
