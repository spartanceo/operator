import { Link } from "wouter";
import { Github, Twitter, MessageCircle, Rss } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Wordmark } from "@/components/brand/wordmark";
import { getBaseUrl } from "@/lib/base-url";

interface FooterColumn {
  /** Translation key under `footer.columns`. */
  titleKey: keyof TranslatedColumnTitles;
  links: { labelKey: keyof TranslatedLinkLabels; href: string; external?: boolean }[];
}

type TranslatedColumnTitles = {
  product: string;
  resources: string;
  creators: string;
  company: string;
  legal: string;
};

type TranslatedLinkLabels = {
  whatItDoes: string;
  download: string;
  pricing: string;
  skillMarketplace: string;
  releaseNotes: string;
  documentation: string;
  skillSdk: string;
  apiReference: string;
  troubleshooting: string;
  becomeCreator: string;
  marketplacePolicy: string;
  revenueShare: string;
  featuredSkills: string;
  about: string;
  manifesto: string;
  pressKit: string;
  contact: string;
  privacy: string;
  terms: string;
  eula: string;
  euAiAct: string;
  openSourceLicences: string;
};

// tier-review: bounded — fixed-size 5-column footer registry, never mutated at runtime
const COLUMNS: ReadonlyArray<FooterColumn> = [
  {
    titleKey: "product",
    links: [
      { labelKey: "whatItDoes", href: "/" },
      { labelKey: "download", href: "/download" },
      { labelKey: "pricing", href: "/pricing" },
      { labelKey: "skillMarketplace", href: "/marketplace" },
      { labelKey: "releaseNotes", href: "/download" },
    ],
  },
  {
    titleKey: "resources",
    links: [
      { labelKey: "documentation", href: "/docs" },
      { labelKey: "skillSdk", href: "/docs/sdk/installing" },
      { labelKey: "apiReference", href: "/docs/api-reference/local-http" },
      { labelKey: "troubleshooting", href: "/docs/troubleshooting/model-wont-load" },
    ],
  },
  {
    titleKey: "creators",
    links: [
      { labelKey: "becomeCreator", href: "/creators" },
      { labelKey: "marketplacePolicy", href: "/docs/skills/best-practices" },
      { labelKey: "revenueShare", href: "/creators" },
      { labelKey: "featuredSkills", href: "/marketplace" },
    ],
  },
  {
    titleKey: "company",
    links: [
      { labelKey: "about", href: "/" },
      { labelKey: "manifesto", href: "/" },
      { labelKey: "pressKit", href: "/" },
      { labelKey: "contact", href: "mailto:hi@omninity.example", external: true },
    ],
  },
  {
    titleKey: "legal",
    links: [
      { labelKey: "privacy", href: "/legal/privacy" },
      { labelKey: "terms", href: "/legal/terms" },
      { labelKey: "eula", href: "/legal/eula" },
      { labelKey: "euAiAct", href: "/legal/eu-ai-act" },
      { labelKey: "openSourceLicences", href: "/legal/open-source" },
    ],
  },
];

export function Footer() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();

  return (
    <footer
      className="mt-32 border-t border-border/60 bg-background"
      aria-label={t("footer.columns.company")}
    >
      <div className="mx-auto max-w-7xl px-5 pb-12 pt-16 md:px-8">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-6">
          <div className="col-span-2 md:col-span-2">
            <Wordmark size="lg" />
            <p className="mt-4 max-w-xs text-sm text-muted-foreground">
              {t("footer.tagline")}
            </p>
            <div className="mt-6 flex items-center gap-2">
              <a
                href="https://github.com/omninity"
                target="_blank"
                rel="noreferrer noopener"
                className="hover-elevate flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label={t("footer.socials.github")}
              >
                <Github className="h-4 w-4" aria-hidden="true" />
              </a>
              <a
                href="https://twitter.com/omninity"
                target="_blank"
                rel="noreferrer noopener"
                className="hover-elevate flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label={t("footer.socials.twitter")}
              >
                <Twitter className="h-4 w-4" aria-hidden="true" />
              </a>
              <a
                href="https://discord.gg/omninity"
                target="_blank"
                rel="noreferrer noopener"
                className="hover-elevate flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label={t("footer.socials.discord")}
              >
                <MessageCircle className="h-4 w-4" aria-hidden="true" />
              </a>
              <a
                href={`${getBaseUrl()}feed.xml`}
                className="hover-elevate flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label={t("footer.socials.rss")}
              >
                <Rss className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.titleKey}>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t(`footer.columns.${col.titleKey}`)}
              </div>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.labelKey}>
                    {link.external ? (
                      <a
                        href={link.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:rounded-sm"
                      >
                        {t(`footer.links.${link.labelKey}`)}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:rounded-sm"
                      >
                        {t(`footer.links.${link.labelKey}`)}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-border/60 pt-6 md:flex-row md:items-center">
          <div className="text-xs text-muted-foreground">
            {t("footer.copyright", { year })}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
              aria-hidden="true"
            />
            {t("footer.statusQuiet")}
          </div>
        </div>
      </div>
    </footer>
  );
}
