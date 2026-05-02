import type { LucideIcon } from "lucide-react";
import {
  AlarmClock,
  Brain,
  Cpu,
  Eye,
  GitBranch,
  HardDrive,
  Layers,
  Lock,
  ScrollText,
  ShieldCheck,
  Workflow,
} from "lucide-react";

export interface CorePower {
  title: string;
  body: string;
  icon: LucideIcon;
}

export const CORE_POWERS: CorePower[] = [
  {
    title: "Drives any application",
    body: "OP sees your screen the way you do and operates real apps — no plugins, no APIs, no integrations to wait on. If you can use it, OP can use it.",
    icon: Eye,
  },
  {
    title: "Runs on your hardware",
    body: "Powered by Ollama, the model lives on your machine. Your laptop's silicon does the work; your private data never leaves it.",
    icon: Cpu,
  },
  {
    title: "Keeps a private memory",
    body: "OP remembers your projects, your style, your decisions. The memory file is yours — encrypted, exportable, deletable in a single click.",
    icon: Brain,
  },
  {
    title: "Asks before it acts",
    body: "Every irreversible action stops at an approval gate. You see exactly what's about to happen, and you say yes.",
    icon: ShieldCheck,
  },
  {
    title: "Composes skills into work",
    body: "Skills are small, reviewed, focused. OP combines them on the fly into the routine you actually need this morning.",
    icon: Layers,
  },
  {
    title: "Logs everything, reversibly",
    body: "Every step is recorded with the file it touched, the bytes it changed, and a one-click undo for the whole chain.",
    icon: ScrollText,
  },
  {
    title: "Works offline by default",
    body: "Network access is opt-in per skill, per session, per call. The default posture is air-gapped and cheerful about it.",
    icon: Lock,
  },
  {
    title: "Wakes up when you do",
    body: "Quiet routines run on your schedule — morning brief at 7:42, weekly retro at Friday 4pm, log triage on the dot.",
    icon: AlarmClock,
  },
  {
    title: "Versioned like real software",
    body: "Skills ship with semantic versions, signed releases, and a public changelog. No silent prompt edits, ever.",
    icon: GitBranch,
  },
  {
    title: "Yours when you uninstall",
    body: "There is no account to close, no data to request. Drag OP to the trash and it leaves a clean computer behind.",
    icon: HardDrive,
  },
];

export interface ReleaseNote {
  version: string;
  date: string;
  highlights: string[];
}

export const CURRENT_RELEASE: ReleaseNote = {
  version: "1.4.2",
  date: "2026-04-22",
  highlights: [
    "Approval gates now show diff previews for file edits",
    "New keyboard-first command palette (press Space twice)",
    "Cuts memory footprint by 18% on machines with <16GB RAM",
    "Skill SDK 0.6 — first-class TypeScript types for memory adapters",
    "Localised UI in 14 languages, all rendered locally",
  ],
};

export const PAST_RELEASES: ReleaseNote[] = [
  {
    version: "1.4.1",
    date: "2026-04-09",
    highlights: ["Fixed approval gate freeze on Windows 11 24H2", "Faster boot on Linux"],
  },
  {
    version: "1.4.0",
    date: "2026-04-01",
    highlights: ["New skill marketplace UI", "Memory file format v3 (auto-migrates)"],
  },
  {
    version: "1.3.4",
    date: "2026-03-18",
    highlights: ["Better resilience to OS sleep mid-action"],
  },
  {
    version: "1.3.0",
    date: "2026-02-26",
    highlights: ["Quiet hours, per-skill network gates, undo manager"],
  },
  {
    version: "1.2.0",
    date: "2026-02-04",
    highlights: ["Command palette, screen reader fixes"],
  },
  {
    version: "1.1.0",
    date: "2026-01-12",
    highlights: ["First public release"],
  },
];

export interface Testimonial {
  quote: string;
  name: string;
  handle: string;
  role: string;
}

export const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "I unplugged the ethernet cable mid-demo to convince myself it was really running locally. It just kept going. That's the moment I knew.",
    name: "Harper Ng",
    handle: "@harper.dev",
    role: "Staff engineer, fintech",
  },
  {
    quote:
      "OP is the first agent I trust enough to give a key to. The approval gates make it feel like I hired a careful intern, not a wild horse.",
    name: "Soren Quist",
    handle: "@soren-q",
    role: "Indie developer",
  },
  {
    quote:
      "I'm a creator with sensitive client work. Cloud agents were a non-starter. OP changed the conversation entirely.",
    name: "Miyaka Tateno",
    handle: "@miyaka",
    role: "Designer + writer",
  },
  {
    quote:
      "The thing I keep coming back to: every action is reversible. That's an engineering decision, not a marketing line.",
    name: "Nathaniel Wren",
    handle: "@nathaniel-w",
    role: "Site reliability lead",
  },
  {
    quote:
      "I built a private skill in an evening. It runs on my machine, only my machine, and earns me money on the marketplace. The web of 2026.",
    name: "Io Renaud",
    handle: "@io-ren",
    role: "Skill creator",
  },
  {
    quote:
      "We replaced three SaaS subscriptions with one folder of OP skills our developers wrote in a hackathon week.",
    name: "Petra Kowalczyk",
    handle: "@petra.k",
    role: "CTO, 22-person co-op",
  },
];

export interface Creator {
  slug: string;
  name: string;
  handle: string;
  monthlyEarnings: number;
  topSkill: string;
  topSkillSlug: string;
  bio: string;
  initials: string;
}

export const TOP_CREATORS: Creator[] = [
  {
    slug: "marek-holub",
    name: "Marek Holub",
    handle: "@marek-h",
    monthlyEarnings: 14820,
    topSkill: "Inbox Triage",
    topSkillSlug: "inbox-triage",
    bio: "Ex-MTA engineer. Builds the morning rituals he wishes someone had built for him.",
    initials: "MH",
  },
  {
    slug: "lin-wei",
    name: "Lin Wei",
    handle: "@lin-w",
    monthlyEarnings: 22310,
    topSkill: "Code Review Companion",
    topSkillSlug: "code-review-companion",
    bio: "Compiler engineer turned skill author. Three of the top ten developer skills are hers.",
    initials: "LW",
  },
  {
    slug: "aiyana-brookes",
    name: "Aiyana Brookes",
    handle: "@aiyana-b",
    monthlyEarnings: 9410,
    topSkill: "Weekly Review",
    topSkillSlug: "weekly-review",
    bio: "Productivity essayist. Writes skills the way she writes — patient, kind, deliberate.",
    initials: "AB",
  },
  {
    slug: "hana-velasco",
    name: "Hana Velasco",
    handle: "@hana-v",
    monthlyEarnings: 11290,
    topSkill: "Receipt Keeper",
    topSkillSlug: "receipt-keeper",
    bio: "CPA + developer. Building the finance toolkit she always wanted small businesses to have.",
    initials: "HV",
  },
  {
    slug: "yusra-mansour",
    name: "Yusra Mansour",
    handle: "@yusra-m",
    monthlyEarnings: 7820,
    topSkill: "Log Detective",
    topSkillSlug: "log-detective",
    bio: "Production engineer at heart. Every skill she ships starts with an incident she lived through.",
    initials: "YM",
  },
  {
    slug: "ines-castellanos",
    name: "Ines Castellanos",
    handle: "@ines-c",
    monthlyEarnings: 8650,
    topSkill: "Design Token Sync",
    topSkillSlug: "design-token-sync",
    bio: "Design systems lead. Bridging tools, codebases, and the people who use them.",
    initials: "IC",
  },
];

export interface FaqItem {
  q: string;
  a: string;
}

export const PRICING_FAQ: FaqItem[] = [
  {
    q: "Is the Free tier really free, forever?",
    a: "Yes. Personal use of OP is free — including unlimited free skills from the marketplace. We make money from the Creator subscription and Enterprise contracts, and we want OP itself to belong to whoever wants it.",
  },
  {
    q: "Do I need a powerful computer to run OP?",
    a: "OP runs on any Mac from 2020 onwards or any Windows machine with 8GB of RAM and a recent CPU. Bigger models give better answers, but the default 7B model handles 95% of everyday work comfortably.",
  },
  {
    q: "Where does the actual AI run?",
    a: "On your machine, in Ollama. We do not operate inference servers and we don't charge per-token. You can swap in any open model Ollama supports.",
  },
  {
    q: "What's included in the Creator tier?",
    a: "Publishing rights to the public marketplace, an 80% revenue share on paid skills, a creator dashboard, signed releases, support for private beta channels, and priority review on new skill submissions.",
  },
  {
    q: "Do you train on my data?",
    a: "Never. The local model doesn't either — Ollama models are read-only at inference time. The only telemetry we collect is opt-in crash reports, and they're scrubbed of file paths and contents before they leave the machine.",
  },
  {
    q: "What happens to my work if I cancel?",
    a: "Nothing. OP keeps working — Free remains free, paid skills you bought remain yours, your memory file remains on your machine. There is no cloud lock-in to escape.",
  },
  {
    q: "Can I deploy OP across my company?",
    a: "Enterprise customers get an MDM-friendly installer, SSO, audit logs, skill whitelisting, an internal skill registry, and a dedicated support engineer. Email enterprise@omninity.example for a conversation.",
  },
  {
    q: "Is OP open source?",
    a: "The skill SDK and runtime are open source under Apache 2.0. The desktop application is source-available — you can read it, fork it, audit it, but commercial redistribution requires a license.",
  },
  {
    q: "Do skills work offline?",
    a: "Most do, by design. Skills must declare any network access they need, and you can revoke that permission at any time without uninstalling the skill.",
  },
  {
    q: "How do approval gates work?",
    a: "Every irreversible action — writing a file, sending a message, running a shell command — stops on a gate that shows you exactly what's about to happen. You can approve once, approve always, or decline.",
  },
];

export interface PricingTier {
  name: string;
  price: string;
  cadence?: string;
  tagline: string;
  cta: string;
  ctaHref: string;
  highlight?: boolean;
  features: string[];
}

export const PRICING_TIERS: PricingTier[] = [
  {
    name: "Free",
    price: "$0",
    cadence: "forever",
    tagline: "Personal use, fully featured.",
    cta: "Download OP",
    ctaHref: "/download",
    features: [
      "Full local agent runtime",
      "All free skills from the marketplace",
      "Approval gates and reversible actions",
      "Local memory and private vault",
      "Community support on Discord and forum",
    ],
  },
  {
    name: "Creator",
    price: "$12",
    cadence: "per month",
    tagline: "Publish skills. Earn revenue. Keep the work.",
    cta: "Become a creator",
    ctaHref: "/creators",
    highlight: true,
    features: [
      "Everything in Free",
      "Publish public and private skills",
      "80% revenue share on paid skills",
      "Creator dashboard with daily stats",
      "Signed releases + private beta channels",
      "Priority review on new submissions",
    ],
  },
  {
    name: "Enterprise",
    price: "Talk to us",
    tagline: "OP, deployed across your company.",
    cta: "Contact sales",
    ctaHref: "mailto:enterprise@omninity.example",
    features: [
      "Everything in Creator",
      "MDM-ready installers (Mac, Windows, Linux)",
      "SSO via SAML and OIDC",
      "Internal skill registry",
      "Skill whitelisting and policy controls",
      "Audit logs with retention controls",
      "Dedicated support engineer",
    ],
  },
];

export const FEATURE_MATRIX: { feature: string; free: string; creator: string; enterprise: string }[] = [
  { feature: "Local agent runtime", free: "yes", creator: "yes", enterprise: "yes" },
  { feature: "Free skills from marketplace", free: "yes", creator: "yes", enterprise: "yes" },
  { feature: "Buy paid skills", free: "yes", creator: "yes", enterprise: "yes" },
  { feature: "Publish public skills", free: "no", creator: "yes", enterprise: "yes" },
  { feature: "Publish private skills", free: "no", creator: "yes", enterprise: "yes" },
  { feature: "Revenue share on paid skills", free: "—", creator: "80%", enterprise: "negotiable" },
  { feature: "Creator dashboard", free: "no", creator: "yes", enterprise: "yes" },
  { feature: "Signed releases", free: "verify", creator: "publish", enterprise: "publish" },
  { feature: "MDM-friendly installer", free: "no", creator: "no", enterprise: "yes" },
  { feature: "SSO (SAML / OIDC)", free: "no", creator: "no", enterprise: "yes" },
  { feature: "Internal skill registry", free: "no", creator: "no", enterprise: "yes" },
  { feature: "Skill whitelisting + policy controls", free: "no", creator: "no", enterprise: "yes" },
  { feature: "Audit logs", free: "local", creator: "local", enterprise: "exportable" },
  { feature: "Support", free: "community", creator: "email", enterprise: "dedicated" },
];

export interface DocSection {
  slug: string;
  title: string;
  pages: DocPage[];
}

export interface DocPage {
  slug: string;
  title: string;
  body: DocBlock[];
}

export type DocBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "callout"; tone: "info" | "warning"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export const DOCS: DocSection[] = [
  {
    slug: "getting-started",
    title: "Getting Started",
    pages: [
      {
        slug: "install",
        title: "Install OP",
        body: [
          {
            kind: "p",
            text: "OP is a desktop application. Download the build for your operating system, drag it into Applications (or run the installer on Windows), and launch it. The first run downloads the default local model via Ollama; expect about 4GB on a fresh machine.",
          },
          { kind: "h", text: "Verify your download" },
          {
            kind: "p",
            text: "Every release ships with a SHA-256 checksum. Verify before you install:",
          },
          {
            kind: "code",
            language: "bash",
            text: "shasum -a 256 ~/Downloads/Omninity-Operator-1.4.2.dmg\n# Should match the checksum on omninity.example/download",
          },
          {
            kind: "callout",
            tone: "info",
            text: "If the checksum does not match, do not install. Email security@omninity.example.",
          },
        ],
      },
      {
        slug: "first-launch",
        title: "First launch",
        body: [
          {
            kind: "p",
            text: "On first launch, OP walks through three setup screens: model choice, permissions, and your declared focus folders. Take your time — every choice can be changed later from Settings.",
          },
          { kind: "h", text: "Permissions" },
          {
            kind: "ul",
            items: [
              "Screen recording — required to drive other applications by sight",
              "Accessibility — required to type and click on your behalf",
              "Notifications — optional, for approval gates",
              "Microphone — optional, only if you install voice skills",
            ],
          },
        ],
      },
      {
        slug: "your-first-skill",
        title: "Your first skill",
        body: [
          {
            kind: "p",
            text: "From the marketplace, install Inbox Triage. The skill page shows you exactly which permissions it needs and what files it will touch. Tap Install in OP and the desktop app picks it up.",
          },
          {
            kind: "p",
            text: "Run the skill from the command palette (Space twice). The first run pauses on every action so you can build trust. Tap Approve always for the steps you're comfortable with.",
          },
        ],
      },
      {
        slug: "the-quiet-tour",
        title: "The quiet tour",
        body: [
          {
            kind: "p",
            text: "The menu bar icon is the entire UI most days. Click it to see what OP is doing right now, what's queued, and what's awaiting your approval. The full window is for setup and history, not for routine work.",
          },
        ],
      },
    ],
  },
  {
    slug: "core-concepts",
    title: "Core Concepts",
    pages: [
      {
        slug: "skills",
        title: "Skills",
        body: [
          {
            kind: "p",
            text: "A skill is a small, reviewed bundle of intent. It declares what it can see, what it can touch, and what it does. The runtime enforces those declarations.",
          },
          {
            kind: "code",
            language: "yaml",
            text: "name: inbox-triage\nversion: 1.4.2\npermissions:\n  - read_window: Mail\n  - type_into_window: Mail\nnetwork: deny\nentry: ./main.ts",
          },
        ],
      },
      {
        slug: "approval-gates",
        title: "Approval gates",
        body: [
          {
            kind: "p",
            text: "Every irreversible step pauses for explicit approval. Approval can be granular (this file, this once) or persistent (this kind of action, in this folder, always).",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Persistent approvals are scoped to a single skill, a single folder, and a single action class. You can never grant an open-ended, app-wide blanket approval — by design.",
          },
        ],
      },
      {
        slug: "memory",
        title: "Memory",
        body: [
          {
            kind: "p",
            text: "OP keeps a private memory of your projects and decisions. The memory file lives under ~/Library/Application Support/Omninity (Mac) or %APPDATA%/Omninity (Windows). It is encrypted at rest with a key in your system keychain.",
          },
          {
            kind: "p",
            text: "You can export the memory as a single tarball, inspect it, edit it in your editor, or delete it without uninstalling OP.",
          },
        ],
      },
      {
        slug: "reversibility",
        title: "Reversibility",
        body: [
          {
            kind: "p",
            text: "OP keeps a transactional log of every action. The undo manager can reverse any single step or any chain of steps within the last 30 days.",
          },
        ],
      },
    ],
  },
  {
    slug: "skills",
    title: "Skills",
    pages: [
      {
        slug: "writing-a-skill",
        title: "Writing a skill",
        body: [
          {
            kind: "p",
            text: "Skills are written in TypeScript against the OP SDK. The minimum viable skill is roughly twenty lines.",
          },
          {
            kind: "code",
            language: "typescript",
            text: "import { defineSkill } from '@omninity/sdk';\n\nexport default defineSkill({\n  name: 'hello',\n  permissions: ['notify'],\n  async run({ ui }) {\n    await ui.notify('Hello from OP');\n  },\n});",
          },
        ],
      },
      {
        slug: "publishing",
        title: "Publishing",
        body: [
          {
            kind: "p",
            text: "Run `op publish` from your skill directory. The CLI signs the release with your creator key and uploads it to the marketplace for review. Review takes 2 business days.",
          },
        ],
      },
      {
        slug: "permissions",
        title: "Permissions",
        body: [
          {
            kind: "p",
            text: "Permissions are declared statically and enforced at runtime. The full grammar is documented in the SDK reference.",
          },
          {
            kind: "ul",
            items: [
              "read_window — read the visible content of a named window",
              "type_into_window — synthesise keystrokes into a window",
              "read_file — read a single file or a single folder",
              "write_file — write to a single file or a single folder",
              "spawn — run a named command with declared arguments",
              "network — make outbound HTTPS requests to a declared host",
              "notify — show a system notification",
            ],
          },
        ],
      },
      {
        slug: "best-practices",
        title: "Best practices",
        body: [
          {
            kind: "ul",
            items: [
              "Ask before doing anything irreversible, even when you have approval",
              "Prefer dry-run output over real action when the user is exploring",
              "Cite the file, line, or window your output came from",
              "Treat the user's time as sacred — favour quiet work over loud progress",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "sdk",
    title: "SDK",
    pages: [
      {
        slug: "installing",
        title: "Installing the SDK",
        body: [
          {
            kind: "code",
            language: "bash",
            text: "npm install @omninity/sdk\n# or\npnpm add @omninity/sdk",
          },
        ],
      },
      {
        slug: "ui",
        title: "The ui handle",
        body: [
          {
            kind: "p",
            text: "Every skill receives a `ui` handle. Use it to show progress, ask questions, and request approval.",
          },
          {
            kind: "code",
            language: "typescript",
            text: "const choice = await ui.ask({\n  prompt: 'Send the drafted reply?',\n  options: ['Send', 'Edit', 'Discard'],\n});",
          },
        ],
      },
      {
        slug: "memory-api",
        title: "Memory API",
        body: [
          {
            kind: "p",
            text: "Skills can read and write namespaced sections of the user's memory. The runtime handles encryption and migration.",
          },
          {
            kind: "code",
            language: "typescript",
            text: "const recent = await memory.read<string[]>('recent-projects', []);\nawait memory.write('recent-projects', [...recent, project]);",
          },
        ],
      },
    ],
  },
  {
    slug: "api-reference",
    title: "API Reference",
    pages: [
      {
        slug: "local-http",
        title: "Local HTTP API",
        body: [
          {
            kind: "p",
            text: "OP exposes a local HTTP server on 127.0.0.1:7427 (loopback only) for skills and external tools that have been granted access. The server is off by default; enable it from Settings → Developer.",
          },
          {
            kind: "table",
            headers: ["Method", "Path", "Description"],
            rows: [
              ["GET", "/v1/status", "Returns the agent's current status and queued actions."],
              ["POST", "/v1/run", "Run a skill by slug with declared input."],
              ["GET", "/v1/skills", "List installed skills and their declared permissions."],
              ["GET", "/v1/memory/:namespace", "Read a memory namespace (requires approval)."],
              ["POST", "/v1/approve/:request_id", "Approve a pending action."],
            ],
          },
        ],
      },
      {
        slug: "events",
        title: "Event stream",
        body: [
          {
            kind: "p",
            text: "Subscribe to the runtime event stream over Server-Sent Events for live action logs.",
          },
          {
            kind: "code",
            language: "bash",
            text: "curl -N http://127.0.0.1:7427/v1/events\n# Returns SSE: action.start, action.gate, action.finish, action.undo",
          },
        ],
      },
      {
        slug: "errors",
        title: "Error codes",
        body: [
          {
            kind: "table",
            headers: ["Code", "Meaning", "What to do"],
            rows: [
              ["401", "Local API not enabled", "Toggle Settings → Developer → Local API."],
              ["403", "Permission not granted", "Approve the requested permission in the UI."],
              ["409", "Action awaiting approval", "Open the menu bar to approve or decline."],
              ["410", "Action was reverted", "Re-run with new input or check the undo log."],
              ["503", "Model not loaded", "Wait for Ollama to finish warming the model."],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    pages: [
      {
        slug: "model-wont-load",
        title: "Model won't load",
        body: [
          {
            kind: "p",
            text: "If the default model fails to load, OP falls back to the smallest installed Ollama model. Check `ollama list` from a terminal to see what's available.",
          },
          {
            kind: "code",
            language: "bash",
            text: "ollama list\nollama pull llama3.2:7b",
          },
        ],
      },
      {
        slug: "approval-gate-stuck",
        title: "Approval gate stuck",
        body: [
          {
            kind: "p",
            text: "If a gate appears frozen, click the menu bar icon and choose Decline. The runtime always honours a decline within 200ms.",
          },
        ],
      },
      {
        slug: "uninstall",
        title: "Uninstall cleanly",
        body: [
          {
            kind: "p",
            text: "Drag OP to the Trash. To remove all data as well, also delete ~/Library/Application Support/Omninity (Mac) or %APPDATA%/Omninity (Windows). OP keeps no other state on your system.",
          },
        ],
      },
    ],
  },
];
