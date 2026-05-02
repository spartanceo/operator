/**
 * English (default) translation bundle.
 *
 * This file is the source of truth for the translation key surface — every
 * other locale must mirror its shape exactly. The CI missing-key detector
 * (`scripts/i18n-check.ts`) flattens each locale's bundle and fails the build
 * if any key present here is missing in another locale.
 *
 * Namespaces correspond to feature areas (`common`, `nav`, `footer`,
 * `a11y`, `settings`). Keep keys lowercase-dot-separated within a namespace
 * (e.g. `nav.product`) to make grepping safe.
 */

type DeepStringRecord = { [k: string]: string | DeepStringRecord };

export const en = {
  common: {
    appName: "Omninity Operator",
    download: "Download OP",
    learnMore: "Learn more",
    loading: "Loading…",
    close: "Close",
    cancel: "Cancel",
  },
  nav: {
    product: "Product",
    marketplace: "Marketplace",
    pricing: "Pricing",
    creators: "Creators",
    docs: "Docs",
    openMenu: "Open menu",
    navigation: "Navigation",
  },
  footer: {
    columns: {
      product: "Product",
      resources: "Resources",
      creators: "Creators",
      company: "Company",
      legal: "Legal",
    },
    links: {
      whatItDoes: "What it does",
      download: "Download",
      pricing: "Pricing",
      skillMarketplace: "Skill marketplace",
      releaseNotes: "Release notes",
      documentation: "Documentation",
      skillSdk: "Skill SDK",
      apiReference: "API reference",
      troubleshooting: "Troubleshooting",
      becomeCreator: "Become a creator",
      marketplacePolicy: "Marketplace policy",
      revenueShare: "Revenue share",
      featuredSkills: "Featured skills",
      about: "About",
      manifesto: "Manifesto",
      pressKit: "Press kit",
      contact: "Contact",
      privacy: "Privacy",
      terms: "Terms",
      eula: "End User Licence",
      euAiAct: "EU AI Act",
      openSourceLicences: "Open source licences",
    },
    tagline:
      "Made for people who want their tools back. Local-first, reversible by default, loyal to the person at the keyboard.",
    copyright: "© {{year}} Omninity, PBC. The private operating layer for your computer.",
    statusQuiet: "All systems quiet.",
    socials: {
      github: "GitHub",
      twitter: "Twitter",
      discord: "Discord",
      rss: "RSS",
    },
  },
  a11y: {
    skipToContent: "Skip to main content",
    languageSelector: "Select language",
    currentLanguage: "Current language: {{language}}",
    openLanguageMenu: "Change language",
  },
  settings: {
    title: "Settings",
    description: "Configure runtime, models, and workspace identity.",
    save: "Save",
    reset: "Reset",
    loading: "Loading…",
    appearance: {
      title: "Appearance",
      description: "Toggle dark or light theme. Persists across sessions.",
      darkMode: "Dark mode",
      currently: "Currently: {{theme}}",
    },
    language: {
      title: "Language",
      description:
        "Choose the language used across the Operator interface. The change applies immediately — no restart required.",
      label: "Interface language",
    },
    runtime: {
      title: "Runtime",
      description: "Ollama endpoint and default model used by agents.",
      ollamaUrl: "Ollama URL",
      defaultModel: "Default model",
      cloudMode: "Cloud mode",
      cloudModeDescription:
        "Allow falling back to a hosted model when the local one is unavailable.",
    },
    workspace: {
      title: "Workspace",
      description:
        "Tenant identity sent on every API request, and the local filesystem path the file tools may touch.",
      tenantId: "Tenant ID",
      workspaceId: "Workspace ID",
      workspacePath: "Workspace path",
    },
    pull: {
      title: "Pull custom model",
      description:
        "All local models reported by Ollama, plus a manual pull for models outside the curated catalogue (advanced).",
      installed: "Installed locally",
      noModels: "No models reported.",
      label: "Pull a model by name",
      placeholder: "e.g. llama3.1:8b",
      action: "Pull",
      actionPending: "Pulling…",
      queued: "Pull queued: {{name}} ({{status}})",
    },
    account: {
      title: "Account",
      description: "Information returned by GET /api/auth/me.",
      notSignedIn:
        "Not signed in. Auth ships in a later milestone — tenant header is used for now.",
    },
  },
} satisfies DeepStringRecord;

export type TranslationShape = typeof en;
