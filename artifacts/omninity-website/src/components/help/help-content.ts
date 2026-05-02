/**
 * Help system content registry.
 *
 * Centralised, statically-typed catalogue of every help article, feature
 * tour, onboarding-checklist item, keyboard shortcut, contextual hint and
 * "new in this release" highlight. Keeping the data shape pure (no JSX,
 * no React imports) lets the help panel search, the tour engine and the
 * shortcut overlay all read from a single source of truth.
 */
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Bot,
  Brain,
  Database,
  Inbox,
  Image as ImageIcon,
  Library,
  MessageSquare,
  Monitor,
  Settings,
  Shield,
  Sparkles,
  Wrench,
  Zap,
} from "lucide-react";

export type HelpCategoryId =
  | "getting-started"
  | "chat-agents"
  | "skills"
  | "desktop-control"
  | "settings"
  | "privacy";

export interface HelpCategory {
  id: HelpCategoryId;
  title: string;
  description: string;
  icon: LucideIcon;
}

export const HELP_CATEGORIES: ReadonlyArray<HelpCategory> = [
  {
    id: "getting-started",
    title: "Getting started",
    description: "Install, set up, and run your first task.",
    icon: Sparkles,
  },
  {
    id: "chat-agents",
    title: "Chat & Agents",
    description: "Talk to OP, run multi-agent goals.",
    icon: Bot,
  },
  {
    id: "skills",
    title: "Skills",
    description: "Install, build, and combine skills.",
    icon: Wrench,
  },
  {
    id: "desktop-control",
    title: "Desktop control",
    description: "Let OP see and operate your apps.",
    icon: Monitor,
  },
  {
    id: "settings",
    title: "Settings",
    description: "Models, hardware, workspace.",
    icon: Settings,
  },
  {
    id: "privacy",
    title: "Privacy",
    description: "Data, exports, approvals, audit.",
    icon: Shield,
  },
];

export interface HelpArticle {
  id: string;
  category: HelpCategoryId;
  title: string;
  summary: string;
  body: ReadonlyArray<string>;
  /** Optional list of related deep-link routes inside the operator. */
  links?: ReadonlyArray<{ label: string; href: string }>;
  /** Indicative search keywords that should match this article. */
  keywords?: ReadonlyArray<string>;
  /** Placeholder for a future video walkthrough. Renders an embed slot. */
  videoUrl?: string;
}

export const HELP_ARTICLES: ReadonlyArray<HelpArticle> = [
  {
    id: "what-is-op",
    category: "getting-started",
    title: "What is Omninity Operator?",
    summary:
      "OP is a local-first multi-agent assistant that runs on your machine.",
    body: [
      "Omninity Operator (OP) is a desktop assistant that lives on your computer. It uses a local model via Ollama, so your data never leaves the machine unless you explicitly approve it.",
      "OP coordinates six specialised agents — Router, Planner, Executor, Verifier, Research, Memory — to plan, run and verify the goals you give it.",
      "Everything risky pauses at an approval gate so you can review what is about to happen before it happens.",
    ],
    links: [
      { label: "Open Chat", href: "/chat" },
      { label: "View Agents", href: "/agents" },
    ],
    keywords: ["overview", "intro", "what", "about"],
  },
  {
    id: "first-run",
    category: "getting-started",
    title: "Your first run",
    summary: "Send your first goal in agent mode.",
    body: [
      "Open Chat and toggle the Agent switch in the header. Type a goal — for example: 'Find the three most-recent items in my inbox and summarise them in a bulleted list'.",
      "OP will route the goal to the Planner, which produces an ordered plan. The Executor calls the right skills. Anything risky pauses for your approval.",
      "When the run completes, the Verifier writes a short summary at the top of the timeline.",
    ],
    links: [{ label: "Open Chat", href: "/chat" }],
    keywords: ["first", "start", "begin", "goal"],
  },
  {
    id: "approvals",
    category: "chat-agents",
    title: "Approval gates",
    summary:
      "Every external write, payment or data egress pauses for your sign-off.",
    body: [
      "Approval gates are the single most important safety feature in OP. Whenever an agent is about to do something irreversible, it pauses and shows you exactly what is about to happen.",
      "Each gate shows the tool name, the input, the affected resource and a risk badge. You can approve, reject, or approve with a note.",
      "You can change the risk threshold for automatic approval in Settings. The default — 'ask before any external write' — is the recommended setting.",
    ],
    links: [
      { label: "Settings", href: "/settings" },
      { label: "Privacy log", href: "/privacy" },
    ],
    keywords: ["approve", "permission", "safety", "gate"],
  },
  {
    id: "agent-roster",
    category: "chat-agents",
    title: "Meet the six agents",
    summary: "Router, Planner, Executor, Verifier, Research, Memory.",
    body: [
      "Router decides whether a message is a chat or a goal that needs the planner.",
      "Planner breaks goals into ordered, risk-classified steps.",
      "Executor calls the registered tools for each step and gates risky calls for approval.",
      "Verifier checks whether the output actually satisfies the original goal.",
      "Research handles browsing and extraction sub-tasks.",
      "Memory reads and writes durable memories across runs so OP gets better at your workflows.",
    ],
    links: [{ label: "Agents page", href: "/agents" }],
    keywords: ["agents", "router", "planner", "executor", "verifier"],
  },
  {
    id: "switching-models",
    category: "settings",
    title: "Switching models",
    summary: "Pick the right model for the job from the chat header.",
    body: [
      "OP works with any Ollama-installed model. The model dropdown in the chat header lets you switch on the fly.",
      "For everyday tasks, balanced 7–8B models like llama3.1:8b are a good default. For code, qwen2.5-coder is excellent.",
      "Heavier models give better reasoning at the cost of speed and RAM. The setup wizard recommends the largest model your hardware can run comfortably.",
    ],
    links: [{ label: "Settings", href: "/settings" }],
    keywords: ["model", "ollama", "switch", "llm"],
  },
  {
    id: "skills-marketplace",
    category: "skills",
    title: "Browsing the marketplace",
    summary: "Find and install community-built skills.",
    body: [
      "The marketplace lists skills built by Omninity and the community. Each skill has a clear description, a list of permissions it requires and a public version history.",
      "Install a skill in one click. Permissions are scoped — a skill can only do what it declares, and OP enforces those bounds.",
      "Skills are signed and pinned by version. You can roll back to a previous version at any time from the Tools page.",
    ],
    links: [{ label: "Tools", href: "/tools" }],
    keywords: ["skills", "marketplace", "install", "store"],
  },
  {
    id: "desktop-control",
    category: "desktop-control",
    title: "Desktop control basics",
    summary: "Let OP see and operate the apps on your screen.",
    body: [
      "Desktop control lets OP take a screenshot, identify UI elements, and click, type or drag — exactly the way you would.",
      "Every desktop action is recorded in the timeline with a one-click undo for the whole chain.",
      "You can disable desktop control entirely in Settings if you want a chat-only experience.",
    ],
    links: [{ label: "Desktop", href: "/desktop" }],
    keywords: ["desktop", "screen", "click", "automation"],
  },
  {
    id: "memory",
    category: "settings",
    title: "How memory works",
    summary: "OP remembers what you tell it, on your machine, encrypted.",
    body: [
      "OP keeps a private memory file scoped to your tenant. Memories are written by the Memory agent and read by the Planner to personalise plans.",
      "You can browse, edit and delete memories at any time from the Memory page.",
      "The memory file is yours — exportable as JSON, deletable in one click, and encrypted at rest.",
    ],
    links: [{ label: "Memory", href: "/memory" }],
    keywords: ["memory", "remember", "context"],
  },
  {
    id: "knowledge",
    category: "skills",
    title: "Knowledge base",
    summary: "Drop documents in and OP can answer questions about them.",
    body: [
      "Add files, folders or URLs to the knowledge base. OP indexes them locally and the Research agent can cite them in its answers.",
      "Indexes are scoped per tenant and never leave the machine.",
    ],
    links: [{ label: "Knowledge", href: "/knowledge" }],
    keywords: ["knowledge", "rag", "documents", "index"],
  },
  {
    id: "data-export",
    category: "privacy",
    title: "Exporting and erasing your data",
    summary: "GDPR-grade export and erase, in two clicks.",
    body: [
      "Open the Privacy page to download a complete JSON export of your tenant's data — runs, messages, memories, knowledge, settings.",
      "The Erase button deletes everything for this tenant on this machine. There is no undo and no copy retained anywhere — the operation is final.",
    ],
    links: [{ label: "Privacy", href: "/privacy" }],
    keywords: ["export", "delete", "erase", "gdpr", "privacy"],
  },
  {
    id: "communications",
    category: "chat-agents",
    title: "Communications inbox",
    summary: "Email, messages and notifications routed through OP.",
    body: [
      "The Communications inbox unifies every channel OP is connected to — email, chat, scheduled briefs.",
      "OP can summarise, draft replies and queue actions for your approval.",
    ],
    links: [{ label: "Communications", href: "/communications" }],
    keywords: ["inbox", "email", "messages", "communications"],
  },
  {
    id: "media",
    category: "skills",
    title: "Media library",
    summary: "Generate and organise images and other assets.",
    body: [
      "The Media page is OP's local store for generated and imported media. Images are tagged, searchable and stored on your disk only.",
    ],
    links: [{ label: "Media", href: "/media" }],
    keywords: ["media", "images", "files", "library"],
  },
];

export interface ShortcutSection {
  title: string;
  shortcuts: ReadonlyArray<{
    id: string;
    keys: ReadonlyArray<string>;
    description: string;
  }>;
}

export const SHORTCUT_SECTIONS: ReadonlyArray<ShortcutSection> = [
  {
    title: "Global",
    shortcuts: [
      { id: "open-help", keys: ["⌘", "/"], description: "Open shortcut reference" },
      { id: "open-help-panel", keys: ["⌘", "?"], description: "Open help centre" },
      { id: "new-conversation", keys: ["⌘", "N"], description: "New conversation" },
      { id: "focus-chat", keys: ["⌘", "K"], description: "Focus chat input" },
    ],
  },
  {
    title: "Chat",
    shortcuts: [
      { id: "send", keys: ["Enter"], description: "Send message" },
      { id: "newline", keys: ["Shift", "Enter"], description: "Insert newline" },
      { id: "approve", keys: ["⌘", "Enter"], description: "Approve last action" },
      { id: "voice", keys: ["⌘", "M"], description: "Toggle voice input" },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { id: "go-chat", keys: ["G", "C"], description: "Go to Chat" },
      { id: "go-agents", keys: ["G", "A"], description: "Go to Agents" },
      { id: "go-privacy", keys: ["G", "P"], description: "Go to Privacy" },
      { id: "go-settings", keys: ["G", "S"], description: "Go to Settings" },
    ],
  },
];

export interface ChecklistItem {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
}

export const CHECKLIST_ITEMS: ReadonlyArray<ChecklistItem> = [
  {
    id: "first-chat",
    title: "Send your first message",
    description: "Open Chat and say hello to OP.",
    href: "/chat",
    icon: MessageSquare,
  },
  {
    id: "agent-run",
    title: "Run your first agent goal",
    description: "Toggle Agent mode and describe what you want done.",
    href: "/chat",
    icon: Bot,
  },
  {
    id: "review-privacy",
    title: "See your privacy log",
    description: "Every sensitive event is recorded — take a look.",
    href: "/privacy",
    icon: Shield,
  },
  {
    id: "explore-skills",
    title: "Browse the tools",
    description: "Skills are how OP gets work done.",
    href: "/tools",
    icon: Wrench,
  },
  {
    id: "tune-settings",
    title: "Tune your settings",
    description: "Confirm your default model and workspace path.",
    href: "/settings",
    icon: Settings,
  },
];

export interface FeatureTourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector for the element the step should highlight. May be null
   *  for intro/outro steps that do not anchor anywhere. */
  selector?: string | null;
}

export interface FeatureTour {
  id: string;
  page: string;
  title: string;
  steps: ReadonlyArray<FeatureTourStep>;
  /** Optional use-case tags — when present the tour is preferred for the
   *  matching onboarding `useCase` value. */
  useCases?: ReadonlyArray<string>;
}

export const FEATURE_TOURS: ReadonlyArray<FeatureTour> = [
  {
    id: "tour-chat",
    page: "/chat",
    title: "Chat tour",
    steps: [
      {
        id: "intro",
        title: "Welcome to Chat",
        body: "Chat is where you talk to OP. Direct messages stay in this view; toggle Agent to run multi-step goals.",
      },
      {
        id: "agent-toggle",
        title: "Agent mode",
        body: "Flip the Agent switch to plan, execute and verify a goal end to end.",
        selector: "[data-testid='switch-agent-mode']",
      },
      {
        id: "model",
        title: "Model selector",
        body: "Pick the model that fits the task — fast for chat, heavier for reasoning.",
        selector: "[data-testid='select-model']",
      },
      {
        id: "send",
        title: "Send",
        body: "Hit Enter to send. Shift+Enter inserts a newline.",
        selector: "[data-testid='button-send']",
      },
    ],
  },
  {
    id: "tour-agents",
    page: "/agents",
    title: "Agents tour",
    steps: [
      {
        id: "roster",
        title: "The roster",
        body: "These are the six agents that collaborate on every goal.",
      },
      {
        id: "runs",
        title: "Run history",
        body: "Recent runs show the plan, the timeline and every approval that was raised.",
      },
    ],
  },
  {
    id: "tour-privacy",
    page: "/privacy",
    title: "Privacy tour",
    steps: [
      {
        id: "intro",
        title: "Your audit log",
        body: "Every privacy-sensitive event is recorded here. Severity badges call out things that need a closer look.",
      },
      {
        id: "export",
        title: "Export & erase",
        body: "GDPR-grade export and erase live in the header. Erase is final — there is no undo.",
      },
    ],
  },
  {
    id: "tour-memory",
    page: "/memory",
    title: "Memory tour",
    steps: [
      {
        id: "intro",
        title: "What OP remembers",
        body: "Each card is a memory the Memory agent wrote during a run. You can edit or delete any of them.",
      },
    ],
  },
  {
    id: "tour-marketplace",
    page: "/tools",
    title: "Skills tour",
    steps: [
      {
        id: "intro",
        title: "Tools & skills",
        body: "Skills are scoped, signed and version-pinned. Install one in a click — uninstall it just as easily.",
      },
    ],
  },
];

export interface ContextHint {
  id: string;
  title: string;
  prompt: string;
}

/** Use-case-keyed contextual chat hints shown when the input is empty. */
export const CONTEXT_HINTS: Record<string, ReadonlyArray<ContextHint>> = {
  default: [
    {
      id: "summarise-inbox",
      title: "Summarise my inbox",
      prompt: "Summarise the last 10 messages in my inbox.",
    },
    {
      id: "draft-followup",
      title: "Draft a follow-up",
      prompt: "Draft a polite follow-up email to a stalled lead.",
    },
    {
      id: "weekly-brief",
      title: "Weekly brief",
      prompt: "Write a Monday brief from my notes and calendar.",
    },
  ],
  productivity: [
    {
      id: "morning-brief",
      title: "Morning brief",
      prompt: "Pull together my morning brief — calendar, inbox, top tasks.",
    },
    {
      id: "summarise-inbox",
      title: "Summarise inbox",
      prompt: "Summarise the last 10 messages in my inbox.",
    },
  ],
  sales: [
    {
      id: "prospect",
      title: "Find prospects",
      prompt: "Find five prospects matching my ICP and draft an opener for each.",
    },
    {
      id: "follow-up",
      title: "Follow-ups",
      prompt: "Draft follow-ups for any stalled deals in my pipeline.",
    },
  ],
  coding: [
    {
      id: "review-pr",
      title: "Review a PR",
      prompt: "Review the latest pull request in my repo and suggest improvements.",
    },
    {
      id: "write-tests",
      title: "Write tests",
      prompt: "Write unit tests for the file I open next.",
    },
  ],
  research: [
    {
      id: "compare",
      title: "Compare options",
      prompt: "Compare three approaches to the problem I'm working on.",
    },
    {
      id: "summarise-paper",
      title: "Summarise a paper",
      prompt: "Summarise the paper I drop in next.",
    },
  ],
  creative: [
    {
      id: "brainstorm",
      title: "Brainstorm",
      prompt: "Brainstorm ten angles for the project I'm thinking about.",
    },
    {
      id: "edit-draft",
      title: "Edit draft",
      prompt: "Edit my latest draft for clarity and pace.",
    },
  ],
};

export interface FeatureHighlight {
  id: string;
  release: string;
  title: string;
  body: string;
  icon: LucideIcon;
}

/** "What's new" badges. Each entry shows a one-time pulse on the matching
 *  feature surface until the user hovers / clicks the badge. */
export const FEATURE_HIGHLIGHTS: ReadonlyArray<FeatureHighlight> = [
  {
    id: "command-palette-v1",
    release: "1.4.2",
    title: "Press ⌘/ for shortcuts",
    body: "We added a keyboard-first reference. Open it from any page.",
    icon: Zap,
  },
  {
    id: "approval-diff-preview",
    release: "1.4.2",
    title: "Approval diffs",
    body: "File-edit approvals now show a diff preview before you sign off.",
    icon: Shield,
  },
];

export const PAGE_ICONS: Record<string, LucideIcon> = {
  "/chat": MessageSquare,
  "/agents": Bot,
  "/desktop": Monitor,
  "/tools": Wrench,
  "/media": ImageIcon,
  "/privacy": Shield,
  "/memory": Brain,
  "/knowledge": Library,
  "/communications": Inbox,
  "/settings": Settings,
  "/help": BookOpen,
  "/help-database": Database,
};

/** Lightweight full-text search over articles. Returns a ranked list. */
export function searchArticles(
  query: string,
  articles: ReadonlyArray<HelpArticle> = HELP_ARTICLES,
): ReadonlyArray<HelpArticle> {
  const q = query.trim().toLowerCase();
  if (!q) return articles;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return articles;

  const scored = articles
    .map((article) => {
      const haystack = [
        article.title,
        article.summary,
        ...article.body,
        ...(article.keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (article.title.toLowerCase().includes(t)) score += 5;
        if ((article.keywords ?? []).some((k) => k.toLowerCase() === t)) score += 4;
        if (article.summary.toLowerCase().includes(t)) score += 3;
        if (haystack.includes(t)) score += 1;
      }
      return { article, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((entry) => entry.article);
}
