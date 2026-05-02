import { useMemo } from "react";
import { Link, useParams, useLocation } from "wouter";
import { ArrowLeft, ArrowRight, BookOpen, Info, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import { DOCS, type DocBlock } from "@/lib/site-data";
import { cn } from "@/lib/utils";

interface ResolvedRoute {
  sectionSlug: string;
  pageSlug: string;
}

function resolve(section: string | undefined, page: string | undefined): ResolvedRoute {
  const sec = DOCS.find((s) => s.slug === section) ?? DOCS[0]!;
  const pg = sec.pages.find((p) => p.slug === page) ?? sec.pages[0]!;
  return { sectionSlug: sec.slug, pageSlug: pg.slug };
}

function Block({ block }: { block: DocBlock }) {
  if (block.kind === "p") {
    return <p className="text-base leading-relaxed text-muted-foreground">{block.text}</p>;
  }
  if (block.kind === "h") {
    return (
      <h3 className="mt-10 text-xl font-semibold tracking-tight text-foreground">{block.text}</h3>
    );
  }
  if (block.kind === "ul") {
    return (
      <ul className="space-y-2.5">
        {block.items.map((item, i) => (
          <li key={i} className="flex items-start gap-2.5 text-base text-muted-foreground">
            <span className="mt-2.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
            {item}
          </li>
        ))}
      </ul>
    );
  }
  if (block.kind === "code") {
    return (
      <pre className="overflow-x-auto rounded-xl border border-border bg-card p-5 font-mono text-[13px] leading-relaxed text-foreground">
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "callout") {
    const Icon = block.tone === "warning" ? AlertTriangle : Info;
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-xl border p-5 text-sm",
          block.tone === "warning"
            ? "border-primary/30 bg-primary/5 text-foreground"
            : "border-border bg-card text-muted-foreground",
        )}
      >
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", block.tone === "warning" ? "text-primary" : "text-muted-foreground")} />
        <span>{block.text}</span>
      </div>
    );
  }
  if (block.kind === "table") {
    return (
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card/80">
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
              {block.headers.map((h) => (
                <th key={h} className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr
                key={i}
                className={cn("border-t border-border/60", i % 2 ? "bg-card/40" : "bg-card")}
              >
                {row.map((cell, j) => (
                  <td key={j} className="px-4 py-3 align-top text-muted-foreground first:font-medium first:text-foreground">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

export default function DocsPage() {
  const params = useParams();
  const [, navigate] = useLocation();
  const route = resolve(
    (params as { section?: string }).section,
    (params as { page?: string }).page,
  );
  const section = DOCS.find((s) => s.slug === route.sectionSlug)!;
  const page = section.pages.find((p) => p.slug === route.pageSlug)!;

  const { prev, next } = useMemo(() => {
    const flat: { sectionSlug: string; pageSlug: string; title: string }[] = [];
    DOCS.forEach((sec) =>
      sec.pages.forEach((pg) =>
        flat.push({ sectionSlug: sec.slug, pageSlug: pg.slug, title: pg.title }),
      ),
    );
    const idx = flat.findIndex(
      (e) => e.sectionSlug === route.sectionSlug && e.pageSlug === route.pageSlug,
    );
    return {
      prev: idx > 0 ? flat[idx - 1] : null,
      next: idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null,
    };
  }, [route.sectionSlug, route.pageSlug]);

  return (
    <>
      <SEO
        title={`${page.title} · Docs`}
        description={`Documentation for ${page.title} in Omninity Operator.`}
      />
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-5 py-14 md:grid-cols-12 md:gap-12 md:px-8">
        <aside className="md:col-span-3">
          <div className="md:sticky md:top-24">
            <button
              type="button"
              onClick={() => navigate("/")}
              className="hover-elevate inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to home
            </button>
            <div className="mt-6 flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium text-foreground">Documentation</span>
            </div>
            <nav className="mt-6 space-y-7">
              {DOCS.map((sec) => (
                <div key={sec.slug}>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {sec.title}
                  </div>
                  <ul className="mt-3 space-y-0.5">
                    {sec.pages.map((pg) => {
                      const active =
                        sec.slug === route.sectionSlug && pg.slug === route.pageSlug;
                      return (
                        <li key={pg.slug}>
                          <Link
                            href={`/docs/${sec.slug}/${pg.slug}`}
                            className={cn(
                              "hover-elevate -mx-2 block rounded-md px-2 py-1.5 text-sm transition-colors",
                              active
                                ? "bg-card text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {pg.title}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </div>
        </aside>
        <article className="md:col-span-9">
          <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {section.title}
          </Badge>
          <h1 className="mt-5 text-balance text-4xl font-semibold tracking-tight md:text-5xl">
            {page.title}
          </h1>
          <div className="mt-10 max-w-3xl space-y-6">
            {page.body.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </div>
          <div className="mt-16 flex flex-col gap-3 border-t border-border/60 pt-8 sm:flex-row sm:items-center sm:justify-between">
            {prev ? (
              <Button variant="outline" asChild className="gap-2">
                <Link href={`/docs/${prev.sectionSlug}/${prev.pageSlug}`}>
                  <ArrowLeft className="h-4 w-4" />
                  {prev.title}
                </Link>
              </Button>
            ) : (
              <span />
            )}
            {next ? (
              <Button variant="outline" asChild className="gap-2">
                <Link href={`/docs/${next.sectionSlug}/${next.pageSlug}`}>
                  {next.title}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            ) : null}
          </div>
        </article>
      </div>
    </>
  );
}
