/**
 * Static marketplace catalogue for the public marketing site.
 *
 * The `omninity-website` artifact is presentation-only and intentionally has
 * no backend wiring (per Task #19 — public-facing site). This module is the
 * sole source of marketplace data the public site renders. When the live
 * marketplace API ships (Task #19 step 4 / `localops-skills-marketplace`),
 * this file's `SKILLS` export is replaced by a thin React Query hook that
 * pulls from `lib/api-client-react`'s generated client. Components consume
 * the `SKILLS`, `findSkill`, `reviewsForSkill`, and `skillsByCreator` exports
 * by name, so the swap is local to this file.
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlarmClock,
  Archive,
  AudioLines,
  Boxes,
  Brain,
  Briefcase,
  Cable,
  Calendar,
  CircuitBoard,
  Clipboard,
  Code2,
  Compass,
  Database,
  Eye,
  FileText,
  Filter,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  HardDrive,
  Inbox,
  Languages,
  Layers,
  LayoutGrid,
  LineChart,
  Lock,
  Mail,
  MessageSquare,
  Mic,
  Music,
  Network,
  Notebook,
  Package,
  PenLine,
  Pin,
  Receipt,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Star,
  Tags,
  Terminal,
  TimerReset,
  Workflow,
} from "lucide-react";

export type SkillCategory =
  | "Productivity"
  | "Developer Tools"
  | "Communication"
  | "Data"
  | "Creative"
  | "System"
  | "Research"
  | "Finance";

export interface Skill {
  slug: string;
  name: string;
  creator: string;
  creatorSlug: string;
  category: SkillCategory;
  installs: number;
  rating: number;
  ratingCount: number;
  tagline: string;
  description: string;
  icon: LucideIcon;
  features: string[];
  permissions: string[];
  versions: { version: string; date: string; notes: string }[];
}

export const CATEGORIES: SkillCategory[] = [
  "Productivity",
  "Developer Tools",
  "Communication",
  "Data",
  "Creative",
  "System",
  "Research",
  "Finance",
];

export const SKILLS: Skill[] = [
  {
    slug: "inbox-triage",
    name: "Inbox Triage",
    creator: "Marek Holub",
    creatorSlug: "marek-holub",
    category: "Communication",
    installs: 18432,
    rating: 4.8,
    ratingCount: 612,
    tagline: "Read the morning mail, file the noise, surface what matters.",
    description:
      "A patient morning routine that opens your mail client, classifies messages by your historical attention pattern, drafts replies for the obvious ones, and shows you only what truly needs a human. Runs locally, never trains on your inbox.",
    icon: Inbox,
    features: [
      "Learns your reply patterns from local history",
      "Drafts in your voice — never sends without approval",
      "Quiet-hours mode for focus blocks",
      "Works with Apple Mail, Outlook, Thunderbird",
    ],
    permissions: ["Read mail client window", "Type into reply composer"],
    versions: [
      { version: "1.4.2", date: "2026-04-22", notes: "Better detection of automated newsletters." },
      { version: "1.4.0", date: "2026-03-30", notes: "Added quiet-hours mode and per-sender priority." },
      { version: "1.3.1", date: "2026-02-18", notes: "Fixed misclassification on calendar invites." },
    ],
  },
  {
    slug: "code-review-companion",
    name: "Code Review Companion",
    creator: "Lin Wei",
    creatorSlug: "lin-wei",
    category: "Developer Tools",
    installs: 24891,
    rating: 4.9,
    ratingCount: 1102,
    tagline: "An honest pair-reviewer for every pull request you open.",
    description:
      "Reads the diff in your editor, runs the project's tests in a sandbox, and writes the review you'd give yourself if you had two more hours. Calls out actual issues, not nitpicks. Stays inside your machine.",
    icon: GitBranch,
    features: [
      "Git-aware — reasons about your branch history",
      "Runs the test suite in an isolated sandbox",
      "Cites the exact lines it's commenting on",
      "Plays well with VS Code, Zed, JetBrains",
    ],
    permissions: ["Read repository files", "Spawn sandboxed processes"],
    versions: [
      { version: "2.1.0", date: "2026-04-28", notes: "New static analyser, faster on large diffs." },
      { version: "2.0.4", date: "2026-04-05", notes: "Better Rust + Go support." },
      { version: "2.0.0", date: "2026-02-12", notes: "Total rewrite around the new agent runtime." },
    ],
  },
  {
    slug: "weekly-review",
    name: "Weekly Review",
    creator: "Aiyana Brookes",
    creatorSlug: "aiyana-brookes",
    category: "Productivity",
    installs: 11204,
    rating: 4.7,
    ratingCount: 487,
    tagline: "A thoughtful Friday wrap-up of everything you actually did.",
    description:
      "Reads through your week's commits, calendar, notes, and inbox, then assembles a private retrospective with what shipped, what stalled, and what's worth carrying into next week. Never leaves the device.",
    icon: Notebook,
    features: [
      "Pulls signal from git, calendar, and notes",
      "Generates a markdown retro you can edit",
      "Gentle suggestions, not metrics theatre",
      "Schedules itself for Friday at 4pm by default",
    ],
    permissions: ["Read calendar", "Read notes folder", "Read git history"],
    versions: [
      { version: "1.2.0", date: "2026-04-12", notes: "Added theme detection across the week." },
      { version: "1.1.0", date: "2026-03-04", notes: "Calendar parser now handles recurring events properly." },
    ],
  },
  {
    slug: "screenshot-archivist",
    name: "Screenshot Archivist",
    creator: "Daichi Mori",
    creatorSlug: "daichi-mori",
    category: "Productivity",
    installs: 7621,
    rating: 4.6,
    ratingCount: 254,
    tagline: "Every screenshot, OCR'd and searchable in seconds.",
    description:
      "Watches your screenshot folder, runs OCR locally, and indexes the result so you can find anything you ever captured by typing what was on the screen. No cloud round-trip, no vendor lock-in.",
    icon: Eye,
    features: [
      "Local OCR via the bundled vision model",
      "Searches by text, app, and date",
      "Auto-tags receipts, code, faces, UI",
      "Supports Mac, Windows screenshot pipelines",
    ],
    permissions: ["Watch screenshot folder", "Read image files"],
    versions: [
      { version: "0.9.4", date: "2026-04-19", notes: "Faster indexing on Apple Silicon." },
      { version: "0.9.0", date: "2026-03-09", notes: "Initial public release." },
    ],
  },
  {
    slug: "spreadsheet-cleaner",
    name: "Spreadsheet Cleaner",
    creator: "Ronan Patel",
    creatorSlug: "ronan-patel",
    category: "Data",
    installs: 9302,
    rating: 4.5,
    ratingCount: 311,
    tagline: "Tidy any messy CSV without leaving your laptop.",
    description:
      "Open a spreadsheet, describe the shape you want, and watch it get there. Handles dates, currencies, deduplication, joins, and column splits — every transform is reviewed before it runs.",
    icon: Filter,
    features: [
      "Step-by-step preview of every transform",
      "Reversible operations — undo any step",
      "Handles CSV, TSV, XLSX, Numbers, Sheets exports",
      "Batch mode for whole folders",
    ],
    permissions: ["Read selected file", "Write back to file"],
    versions: [
      { version: "1.7.1", date: "2026-04-20", notes: "Better date format inference." },
      { version: "1.7.0", date: "2026-03-22", notes: "New batch mode for folder-level cleaning." },
    ],
  },
  {
    slug: "meeting-summary",
    name: "Meeting Summary",
    creator: "Sora Kowalski",
    creatorSlug: "sora-kowalski",
    category: "Communication",
    installs: 16980,
    rating: 4.7,
    ratingCount: 728,
    tagline: "Local transcription and summary for every call.",
    description:
      "Captures system audio during a meeting, transcribes it on-device, and produces a tight summary with action items and decisions. Recording is always opt-in and visible in the menu bar.",
    icon: Mic,
    features: [
      "On-device transcription, no cloud",
      "Highlights decisions, action items, owners",
      "Pulls calendar context for attendee names",
      "Exports markdown, PDF, or your notes app",
    ],
    permissions: ["Capture system audio", "Read calendar"],
    versions: [
      { version: "1.5.2", date: "2026-04-25", notes: "Better speaker diarisation." },
      { version: "1.5.0", date: "2026-04-01", notes: "New summary template engine." },
    ],
  },
  {
    slug: "design-token-sync",
    name: "Design Token Sync",
    creator: "Ines Castellanos",
    creatorSlug: "ines-castellanos",
    category: "Creative",
    installs: 5421,
    rating: 4.6,
    ratingCount: 188,
    tagline: "Keep Figma and your codebase honest about colour.",
    description:
      "Reads tokens from your Figma file, diffs them against the variables in your repo, and proposes a minimal patch. Works offline once the file is exported.",
    icon: Layers,
    features: [
      "Round-trip Figma <-> code",
      "Supports Tailwind, CSS variables, design tokens JSON",
      "Stages every change for review",
      "Plays well with monorepos",
    ],
    permissions: ["Read repository files", "Read exported Figma file"],
    versions: [
      { version: "0.6.3", date: "2026-04-18", notes: "Round-trip support for typography tokens." },
      { version: "0.6.0", date: "2026-03-11", notes: "Initial release." },
    ],
  },
  {
    slug: "receipt-keeper",
    name: "Receipt Keeper",
    creator: "Hana Velasco",
    creatorSlug: "hana-velasco",
    category: "Finance",
    installs: 12740,
    rating: 4.8,
    ratingCount: 542,
    tagline: "Every receipt, categorised and ready for the accountant.",
    description:
      "Watches your downloads folder for receipts and invoices, extracts the totals locally, and sorts them into a tidy structure your accountant will actually thank you for.",
    icon: Receipt,
    features: [
      "Local OCR for paper and PDF receipts",
      "Auto-categorisation with manual override",
      "Exports to QuickBooks, Xero, or plain CSV",
      "Multi-currency aware",
    ],
    permissions: ["Watch downloads folder", "Read PDF/image files"],
    versions: [
      { version: "1.3.5", date: "2026-04-14", notes: "Better handling of multi-currency invoices." },
      { version: "1.3.0", date: "2026-03-19", notes: "New Xero export." },
    ],
  },
  {
    slug: "deep-search",
    name: "Deep Search",
    creator: "Otto Lindqvist",
    creatorSlug: "otto-lindqvist",
    category: "Research",
    installs: 14093,
    rating: 4.7,
    ratingCount: 601,
    tagline: "Patient, citation-first research across your whole machine.",
    description:
      "Asks a real question and reasons across your local notes, downloads, and bookmarks before reaching for the internet. Every claim cites the file it came from.",
    icon: Compass,
    features: [
      "Citations point to the file and line",
      "Searches your notes, PDFs, bookmarks, and browser history",
      "Optional web search with explicit opt-in",
      "Saves the answer with sources to your notes app",
    ],
    permissions: ["Read notes folder", "Read browser history", "Network access (opt-in per query)"],
    versions: [
      { version: "0.8.2", date: "2026-04-21", notes: "Faster reranker on long documents." },
      { version: "0.8.0", date: "2026-03-29", notes: "New citation engine." },
    ],
  },
  {
    slug: "log-detective",
    name: "Log Detective",
    creator: "Yusra Mansour",
    creatorSlug: "yusra-mansour",
    category: "Developer Tools",
    installs: 8740,
    rating: 4.6,
    ratingCount: 297,
    tagline: "Find the actual error in 10,000 lines of log noise.",
    description:
      "Tail any log file or watch any container, and let the agent surface the real problem. Knows the difference between a warning and a smoking gun.",
    icon: Terminal,
    features: [
      "Tails files, journalctl, Docker, and pods",
      "Clusters error patterns over time windows",
      "Suggests likely root causes with citations",
      "Can pause to ask before running diagnostics",
    ],
    permissions: ["Read log files", "Spawn read-only diagnostic commands"],
    versions: [
      { version: "1.1.0", date: "2026-04-17", notes: "New cluster view for time-windowed errors." },
      { version: "1.0.0", date: "2026-03-25", notes: "First stable release." },
    ],
  },
  {
    slug: "calendar-architect",
    name: "Calendar Architect",
    creator: "Bram De Vos",
    creatorSlug: "bram-de-vos",
    category: "Productivity",
    installs: 6810,
    rating: 4.4,
    ratingCount: 213,
    tagline: "Plans your week around the work that actually matters.",
    description:
      "Reads your goals for the week, your calendar, and your historical focus patterns. Proposes a layout, books focus blocks, and protects your morning. Every change is reviewed.",
    icon: Calendar,
    features: [
      "Honours your declared focus hours",
      "Negotiates conflicts with sane defaults",
      "Works with Google, Apple, Outlook calendars",
      "Optional weekly Sunday-night planning ritual",
    ],
    permissions: ["Read calendar", "Modify calendar (with approval)"],
    versions: [
      { version: "1.0.6", date: "2026-04-09", notes: "Better Outlook recurrence handling." },
      { version: "1.0.0", date: "2026-03-15", notes: "Stable release." },
    ],
  },
  {
    slug: "music-librarian",
    name: "Music Librarian",
    creator: "Lex Okafor",
    creatorSlug: "lex-okafor",
    category: "Creative",
    installs: 4221,
    rating: 4.5,
    ratingCount: 142,
    tagline: "Tame your local music collection without losing your taste.",
    description:
      "Organises a sprawling music folder by mood, era, and tempo using local audio embeddings. Builds playlists for the kind of evening you describe, all on-device.",
    icon: Music,
    features: [
      "Local audio fingerprinting and embeddings",
      "Mood-based playlist generation",
      "Cleans up bad metadata without overwriting",
      "Exports M3U for any player",
    ],
    permissions: ["Read music folder", "Modify metadata (with approval)"],
    versions: [
      { version: "0.5.1", date: "2026-04-11", notes: "Better tempo detection on jazz and classical." },
      { version: "0.5.0", date: "2026-03-20", notes: "Initial release." },
    ],
  },
  {
    slug: "private-translate",
    name: "Private Translate",
    creator: "Mira Solberg",
    creatorSlug: "mira-solberg",
    category: "Communication",
    installs: 9842,
    rating: 4.6,
    ratingCount: 372,
    tagline: "On-device translation for the messages you can't put in the cloud.",
    description:
      "A keyboard shortcut translates the selected text in any app without it ever leaving your computer. Supports 28 languages out of the box.",
    icon: Languages,
    features: [
      "28 languages, all on-device",
      "Global hotkey works in any app",
      "Tone presets — formal, casual, technical",
      "Optional clipboard mode",
    ],
    permissions: ["Read selected text via Accessibility API"],
    versions: [
      { version: "1.2.1", date: "2026-04-23", notes: "Improved Korean and Vietnamese quality." },
      { version: "1.2.0", date: "2026-03-31", notes: "New tone presets." },
    ],
  },
  {
    slug: "system-doctor",
    name: "System Doctor",
    creator: "Reza Alavi",
    creatorSlug: "reza-alavi",
    category: "System",
    installs: 13210,
    rating: 4.7,
    ratingCount: 489,
    tagline: "Honest diagnostics for the times your laptop slows down.",
    description:
      "Checks disk, memory, CPU, and background processes against your historical baseline. Names the actual culprit and offers a reversible fix. No telemetry.",
    icon: Gauge,
    features: [
      "Reads from system tools — never installs spyware",
      "Compares against your own historical baseline",
      "Every fix is reversible with one click",
      "Generates a report you can share with support",
    ],
    permissions: ["Read system process info"],
    versions: [
      { version: "2.0.0", date: "2026-04-26", notes: "Total rewrite, much faster scans." },
      { version: "1.6.0", date: "2026-03-12", notes: "Added battery health checks." },
    ],
  },
  {
    slug: "deploy-shepherd",
    name: "Deploy Shepherd",
    creator: "Lin Wei",
    creatorSlug: "lin-wei",
    category: "Developer Tools",
    installs: 6402,
    rating: 4.7,
    ratingCount: 219,
    tagline: "Walks you through the deploy without taking the wheel.",
    description:
      "Reads your deploy scripts, your CI history, and your infra configs. Runs your normal deploy command, watches the logs, and pauses to ask when something looks unusual.",
    icon: Workflow,
    features: [
      "Pauses on every irreversible step",
      "Tails CI logs while you watch",
      "Compares against your last 20 deploys",
      "Records a private replay you can review",
    ],
    permissions: ["Read deploy configs", "Run deploy commands (with approval)"],
    versions: [
      { version: "0.7.0", date: "2026-04-15", notes: "New replay viewer." },
      { version: "0.6.0", date: "2026-03-08", notes: "Initial release." },
    ],
  },
  {
    slug: "browser-archivist",
    name: "Browser Archivist",
    creator: "Aiyana Brookes",
    creatorSlug: "aiyana-brookes",
    category: "Research",
    installs: 5890,
    rating: 4.5,
    ratingCount: 196,
    tagline: "Every article you read, kept and searchable.",
    description:
      "Snapshots and indexes the articles you actually read in your browser. Search them later by what they were about, not what their URLs were called.",
    icon: Archive,
    features: [
      "Local snapshots — survives link rot",
      "Searchable by topic, author, or quote",
      "Optional reading-time stats",
      "Plays well with Firefox, Safari, Arc, Chrome",
    ],
    permissions: ["Read browser history", "Capture page content (per page)"],
    versions: [
      { version: "0.4.2", date: "2026-04-13", notes: "Better article extraction on news sites." },
      { version: "0.4.0", date: "2026-03-17", notes: "New search experience." },
    ],
  },
  {
    slug: "personal-cfo",
    name: "Personal CFO",
    creator: "Hana Velasco",
    creatorSlug: "hana-velasco",
    category: "Finance",
    installs: 8930,
    rating: 4.6,
    ratingCount: 312,
    tagline: "Reads your statements, asks the questions a friend would.",
    description:
      "Aggregates your downloaded bank statements and credit card exports. Notices the trends and asks gentle questions about subscriptions you forgot. Everything stays on your machine.",
    icon: LineChart,
    features: [
      "Reads PDF and CSV statements",
      "Detects forgotten subscriptions",
      "Categorises against your declared goals",
      "Never connects to your bank directly",
    ],
    permissions: ["Read selected statement files"],
    versions: [
      { version: "1.1.4", date: "2026-04-08", notes: "Better detection of free-trial conversions." },
      { version: "1.1.0", date: "2026-03-02", notes: "Multi-account support." },
    ],
  },
  {
    slug: "doc-typist",
    name: "Doc Typist",
    creator: "Theo Marchetti",
    creatorSlug: "theo-marchetti",
    category: "Productivity",
    installs: 4012,
    rating: 4.4,
    ratingCount: 128,
    tagline: "Dictate long documents the old way — by talking.",
    description:
      "Live local dictation that handles paragraphs, punctuation, and formatting commands. Built for people who think in long sentences.",
    icon: PenLine,
    features: [
      "Live on-device transcription",
      "Voice formatting commands (heading, bullet, italic)",
      "Custom vocabulary per document",
      "Works in any text field",
    ],
    permissions: ["Microphone", "Type via Accessibility API"],
    versions: [
      { version: "0.9.1", date: "2026-04-16", notes: "Better punctuation in long sentences." },
      { version: "0.9.0", date: "2026-03-23", notes: "Initial release." },
    ],
  },
  {
    slug: "data-explainer",
    name: "Data Explainer",
    creator: "Ronan Patel",
    creatorSlug: "ronan-patel",
    category: "Data",
    installs: 7180,
    rating: 4.6,
    ratingCount: 248,
    tagline: "Explore any dataset with plain questions and honest charts.",
    description:
      "Open a CSV, ask a question, get a chart and a paragraph that explains what you're looking at. The chart is real. The paragraph cites the rows it came from.",
    icon: LayoutGrid,
    features: [
      "Local DuckDB engine — no upload",
      "Charts cite the rows they summarise",
      "Saves a notebook of every question asked",
      "Plays well with parquet, CSV, JSON",
    ],
    permissions: ["Read selected file"],
    versions: [
      { version: "0.7.4", date: "2026-04-19", notes: "Faster on >10M-row files." },
      { version: "0.7.0", date: "2026-03-21", notes: "New citation panel." },
    ],
  },
  {
    slug: "sketch-to-code",
    name: "Sketch to Code",
    creator: "Ines Castellanos",
    creatorSlug: "ines-castellanos",
    category: "Creative",
    installs: 6230,
    rating: 4.5,
    ratingCount: 207,
    tagline: "Turn a hand-drawn UI into honest React.",
    description:
      "Photograph a sketch with your phone, drop it on the desktop, and OP returns clean React components in your project's style. Always pauses for review.",
    icon: Sparkles,
    features: [
      "Reads photos and Figma exports",
      "Matches your project's component conventions",
      "Generates Tailwind, CSS Modules, or vanilla CSS",
      "Pauses for approval before writing files",
    ],
    permissions: ["Read selected image", "Write to project folder (with approval)"],
    versions: [
      { version: "0.5.2", date: "2026-04-10", notes: "Better handling of grid layouts." },
      { version: "0.5.0", date: "2026-03-14", notes: "Initial public release." },
    ],
  },
  {
    slug: "process-keeper",
    name: "Process Keeper",
    creator: "Reza Alavi",
    creatorSlug: "reza-alavi",
    category: "System",
    installs: 3920,
    rating: 4.5,
    ratingCount: 121,
    tagline: "Restart background services without thinking about it.",
    description:
      "Watches the daemons you depend on (databases, queues, dev servers) and restarts them with the right flags when they crash. Logs every action it takes.",
    icon: CircuitBoard,
    features: [
      "Per-service restart policy",
      "Backoff with sane defaults",
      "Optional menu-bar status",
      "Plays well with launchd, systemd, Windows services",
    ],
    permissions: ["Manage configured services"],
    versions: [
      { version: "0.4.1", date: "2026-04-07", notes: "New backoff policy options." },
      { version: "0.4.0", date: "2026-03-13", notes: "Initial release." },
    ],
  },
  {
    slug: "thread-keeper",
    name: "Thread Keeper",
    creator: "Sora Kowalski",
    creatorSlug: "sora-kowalski",
    category: "Communication",
    installs: 5210,
    rating: 4.4,
    ratingCount: 168,
    tagline: "Resurfaces the conversations you owe a reply to.",
    description:
      "Quietly tracks the threads you've started across mail, Slack, and Signal. Tells you when a reply is overdue without being a nag. All locally.",
    icon: MessageSquare,
    features: [
      "Single overdue list across mail and chat",
      "Custom SLAs per contact",
      "Optional morning brief",
      "No data ever leaves the machine",
    ],
    permissions: ["Read mail and chat clients (selected)"],
    versions: [
      { version: "0.6.0", date: "2026-04-06", notes: "New per-contact SLA controls." },
      { version: "0.5.0", date: "2026-03-10", notes: "Slack support." },
    ],
  },
  {
    slug: "library-keeper",
    name: "Library Keeper",
    creator: "Otto Lindqvist",
    creatorSlug: "otto-lindqvist",
    category: "Research",
    installs: 4690,
    rating: 4.6,
    ratingCount: 161,
    tagline: "Index your PDF library and ask it real questions.",
    description:
      "Builds a private vector index of every PDF in a folder. Ask whole-library questions and get answers with the page number you need.",
    icon: FileText,
    features: [
      "Local embedding model, no upload",
      "Per-document and whole-library questions",
      "Page-level citations",
      "Plays well with Zotero, DEVONthink, plain folders",
    ],
    permissions: ["Read selected folder"],
    versions: [
      { version: "1.0.3", date: "2026-04-24", notes: "Faster indexing on slow disks." },
      { version: "1.0.0", date: "2026-03-27", notes: "First stable release." },
    ],
  },
  {
    slug: "tax-folder",
    name: "Tax Folder",
    creator: "Hana Velasco",
    creatorSlug: "hana-velasco",
    category: "Finance",
    installs: 3801,
    rating: 4.5,
    ratingCount: 109,
    tagline: "Quietly assembles everything your accountant needs.",
    description:
      "Picks up tax-relevant files from across your machine all year, not the night before. Hands your accountant a tidy folder when the time comes.",
    icon: Folder,
    features: [
      "Year-round collection from declared sources",
      "Per-jurisdiction templates",
      "Encrypted handoff package",
      "Reversible — never deletes originals",
    ],
    permissions: ["Read declared folders"],
    versions: [
      { version: "0.3.2", date: "2026-04-04", notes: "New EU jurisdiction templates." },
      { version: "0.3.0", date: "2026-03-06", notes: "First public release." },
    ],
  },
  {
    slug: "shell-second-brain",
    name: "Shell Second Brain",
    creator: "Yusra Mansour",
    creatorSlug: "yusra-mansour",
    category: "Developer Tools",
    installs: 7990,
    rating: 4.7,
    ratingCount: 281,
    tagline: "Remembers the command you ran six months ago.",
    description:
      "Indexes your shell history with rich context — what folder, what project, what error came after. Pulls up the exact incantation when you ask in plain English.",
    icon: SquareTerminal,
    features: [
      "Searchable by intent, not just text",
      "Per-project history scoping",
      "Reconstructs failed pipelines",
      "Works with bash, zsh, fish",
    ],
    permissions: ["Read shell history files"],
    versions: [
      { version: "0.8.0", date: "2026-04-27", notes: "New project-aware scoping." },
      { version: "0.7.0", date: "2026-03-26", notes: "Fish support." },
    ],
  },
  {
    slug: "podcast-clipper",
    name: "Podcast Clipper",
    creator: "Lex Okafor",
    creatorSlug: "lex-okafor",
    category: "Creative",
    installs: 3120,
    rating: 4.4,
    ratingCount: 98,
    tagline: "Find the one moment in a 90-minute episode worth sharing.",
    description:
      "Drop in a podcast file, and OP transcribes it locally and surfaces the most quotable 30-second clips. Exports a sharable card with attribution.",
    icon: AudioLines,
    features: [
      "Local transcription and clip ranking",
      "Card export with attribution",
      "Per-episode quote library",
      "Plays well with mp3, m4a, opus",
    ],
    permissions: ["Read selected audio file"],
    versions: [
      { version: "0.4.0", date: "2026-04-02", notes: "New card layouts." },
      { version: "0.3.0", date: "2026-03-05", notes: "Initial release." },
    ],
  },
  {
    slug: "ssh-runbook",
    name: "SSH Runbook",
    creator: "Lin Wei",
    creatorSlug: "lin-wei",
    category: "System",
    installs: 4730,
    rating: 4.5,
    ratingCount: 153,
    tagline: "Walks the runbook with you, never ahead of you.",
    description:
      "Open a runbook, and OP runs each step on your declared SSH targets, pausing for approval at every change. Captures the output to a private incident log.",
    icon: Cable,
    features: [
      "Step-by-step approval gates",
      "Multi-target fan-out with safe defaults",
      "Private incident log per run",
      "Reads your existing runbook markdown",
    ],
    permissions: ["SSH to declared targets"],
    versions: [
      { version: "0.6.1", date: "2026-04-29", notes: "Better partial-failure UX." },
      { version: "0.6.0", date: "2026-04-03", notes: "Initial public release." },
    ],
  },
  {
    slug: "morning-brief",
    name: "Morning Brief",
    creator: "Marek Holub",
    creatorSlug: "marek-holub",
    category: "Productivity",
    installs: 11580,
    rating: 4.7,
    ratingCount: 391,
    tagline: "A two-minute briefing on your day, before you open anything.",
    description:
      "Reads your calendar, your overdue threads, the weather, and your news subscriptions. Reads it back in a calm two minutes while you make coffee.",
    icon: AlarmClock,
    features: [
      "Two-minute audio brief, every morning",
      "Source list under your control",
      "Optional do-not-disturb during brief",
      "Falls back to text if you'd rather read",
    ],
    permissions: ["Read calendar", "Read configured RSS feeds"],
    versions: [
      { version: "0.7.0", date: "2026-04-30", notes: "New voice options." },
      { version: "0.6.0", date: "2026-03-28", notes: "RSS-only mode." },
    ],
  },
  {
    slug: "secret-scanner",
    name: "Secret Scanner",
    creator: "Reza Alavi",
    creatorSlug: "reza-alavi",
    category: "Developer Tools",
    installs: 5870,
    rating: 4.8,
    ratingCount: 224,
    tagline: "Catch credentials before they ever hit a remote.",
    description:
      "Scans your repos and clipboard for accidentally-committed secrets. Suggests a rotation runbook for each finding, never sends the secret anywhere.",
    icon: ShieldCheck,
    features: [
      "Pre-commit and clipboard hooks",
      "Per-finding rotation runbook",
      "Custom rules for your stack",
      "Always offline",
    ],
    permissions: ["Read repository files", "Read clipboard (with approval)"],
    versions: [
      { version: "1.2.0", date: "2026-04-24", notes: "New rotation runbook engine." },
      { version: "1.1.0", date: "2026-03-24", notes: "Custom rule support." },
    ],
  },
  {
    slug: "snippet-vault",
    name: "Snippet Vault",
    creator: "Daichi Mori",
    creatorSlug: "daichi-mori",
    category: "Developer Tools",
    installs: 4290,
    rating: 4.5,
    ratingCount: 137,
    tagline: "Searchable code snippets, organised the way you actually think.",
    description:
      "A keyboard-first snippet manager that learns the shape of the snippets you save and surfaces them when you describe what you need.",
    icon: Code2,
    features: [
      "Vector search across your snippets",
      "Project-scoped suggestions",
      "Markdown sync for portability",
      "Global hotkey",
    ],
    permissions: ["Read snippet folder"],
    versions: [
      { version: "0.5.3", date: "2026-04-26", notes: "Better project-context suggestions." },
      { version: "0.5.0", date: "2026-03-16", notes: "Initial public release." },
    ],
  },
];

export function findSkill(slug: string): Skill | undefined {
  return SKILLS.find((s) => s.slug === slug);
}

export function skillsByCreator(creatorSlug: string): Skill[] {
  return SKILLS.filter((s) => s.creatorSlug === creatorSlug);
}

export interface SkillReview {
  author: string;
  rating: number;
  date: string;
  body: string;
}

const REVIEW_AUTHORS = [
  "harper.dev",
  "soren-q",
  "miyaka",
  "nathaniel-w",
  "io-ren",
  "petra.k",
  "salim-h",
  "june-arc",
  "tovar.os",
  "kanon-y",
];

const REVIEW_TEMPLATES = [
  "Replaced a paid SaaS subscription on day one. The local-first thing is not just marketing — I unplugged my ethernet to test it.",
  "First skill I've installed that didn't try to upsell me into something. It does one thing and it does it well.",
  "The approval-gate model is the right call. I trust this more than the cloud equivalents I was using.",
  "Solid. Five-star not because it's perfect but because the team obviously cares.",
  "Took a couple of days to find the right rhythm with it. Now I can't remember how I worked without it.",
  "Bought OP for this skill alone. Worth it.",
  "Honest software. Not a single dark pattern in sight.",
  "The version history is the polish I didn't know I needed. Easy to roll back when an update changes a default.",
];

export function reviewsForSkill(slug: string): SkillReview[] {
  const seed = slug
    .split("")
    .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const count = 4 + (seed % 3);
  const out: SkillReview[] = [];
  for (let i = 0; i < count; i++) {
    const a = REVIEW_AUTHORS[(seed + i * 7) % REVIEW_AUTHORS.length] ?? "anon";
    const body = REVIEW_TEMPLATES[(seed + i * 13) % REVIEW_TEMPLATES.length] ?? "Solid.";
    const rating = 4 + ((seed + i) % 2);
    const day = 1 + ((seed + i * 5) % 27);
    const month = 1 + ((seed + i * 3) % 4);
    out.push({
      author: a,
      rating,
      date: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      body,
    });
  }
  return out;
}

export const ALL_ICONS = {
  Activity,
  AlarmClock,
  Archive,
  AudioLines,
  Boxes,
  Brain,
  Briefcase,
  Cable,
  Calendar,
  CircuitBoard,
  Clipboard,
  Code2,
  Compass,
  Database,
  Eye,
  FileText,
  Filter,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  HardDrive,
  Inbox,
  Languages,
  Layers,
  LayoutGrid,
  LineChart,
  Lock,
  Mail,
  MessageSquare,
  Mic,
  Music,
  Network,
  Notebook,
  Package,
  PenLine,
  Pin,
  Receipt,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Star,
  Tags,
  Terminal,
  TimerReset,
  Workflow,
};
