import { Link } from "wouter";
import { Github, Twitter, MessageCircle, Rss } from "lucide-react";
import { Wordmark } from "@/components/brand/wordmark";

interface FooterColumn {
  title: string;
  links: { label: string; href: string; external?: boolean }[];
}

const COLUMNS: FooterColumn[] = [
  {
    title: "Product",
    links: [
      { label: "What it does", href: "/" },
      { label: "Download", href: "/download" },
      { label: "Pricing", href: "/pricing" },
      { label: "Skill marketplace", href: "/marketplace" },
      { label: "Release notes", href: "/download" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Skill SDK", href: "/docs/sdk/installing" },
      { label: "API reference", href: "/docs/api-reference/local-http" },
      { label: "Troubleshooting", href: "/docs/troubleshooting/model-wont-load" },
    ],
  },
  {
    title: "Creators",
    links: [
      { label: "Become a creator", href: "/creators" },
      { label: "Marketplace policy", href: "/docs/skills/best-practices" },
      { label: "Revenue share", href: "/creators" },
      { label: "Featured skills", href: "/marketplace" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/" },
      { label: "Manifesto", href: "/" },
      { label: "Press kit", href: "/" },
      { label: "Contact", href: "mailto:hi@omninity.example", external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/" },
      { label: "Terms", href: "/" },
      { label: "Security", href: "/" },
      { label: "Open source licences", href: "/" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="mt-32 border-t border-border/60 bg-background">
      <div className="mx-auto max-w-7xl px-5 pb-12 pt-16 md:px-8">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-6">
          <div className="col-span-2 md:col-span-2">
            <Wordmark size="lg" />
            <p className="mt-4 max-w-xs text-sm text-muted-foreground">
              Made for people who want their tools back. Local-first, reversible by default,
              loyal to the person at the keyboard.
            </p>
            <div className="mt-6 flex items-center gap-2">
              <a
                href="https://github.com/omninity"
                target="_blank"
                rel="noreferrer noopener"
                className="hover-elevate flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground"
                aria-label="GitHub"
              >
                <Github className="h-4 w-4" />
              </a>
              <a
                href="https://twitter.com/omninity"
                target="_blank"
                rel="noreferrer noopener"
                className="hover-elevate flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Twitter"
              >
                <Twitter className="h-4 w-4" />
              </a>
              <a
                href="https://discord.gg/omninity"
                target="_blank"
                rel="noreferrer noopener"
                className="hover-elevate flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Discord"
              >
                <MessageCircle className="h-4 w-4" />
              </a>
              <a
                href={`${import.meta.env.BASE_URL}feed.xml`}
                className="hover-elevate flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground"
                aria-label="RSS"
              >
                <Rss className="h-4 w-4" />
              </a>
            </div>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {col.title}
              </div>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a
                        href={link.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {link.label}
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
            © 2026 Omninity, PBC. The private operating layer for your computer.
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
            All systems quiet.
          </div>
        </div>
      </div>
    </footer>
  );
}
