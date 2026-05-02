import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Search, ThumbsDown, ThumbsUp, Video } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useHelp } from "./help-context";
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  type HelpArticle,
  type HelpCategoryId,
  searchArticles,
} from "./help-content";

/**
 * Slide-out help panel. Hosts:
 *  - full-text search across every article
 *  - category navigation (Getting started → Privacy)
 *  - the active article with feedback (Was this helpful?)
 *  - placeholder for video walkthroughs (visual slot ready for embeds)
 */
export function HelpPanel() {
  const { panel, closePanel, feedback, setArticleFeedback } = useHelp();
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const articleRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  // When the panel opens with a deep-link article id, surface that article
  // as the visible selection AND scroll its node into view.
  useEffect(() => {
    if (panel.open && panel.articleId) {
      setActiveId(panel.articleId);
      setQuery("");
      // Defer one frame so the DOM is mounted before the scroll.
      const t = setTimeout(() => {
        articleRefs.current
          .get(panel.articleId ?? "")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [panel.open, panel.articleId]);

  const visibleArticles = useMemo(
    () => searchArticles(query),
    [query],
  );

  const grouped = useMemo(() => {
    const map = new Map<HelpCategoryId, HelpArticle[]>();
    for (const cat of HELP_CATEGORIES) map.set(cat.id, []);
    for (const article of visibleArticles) {
      const list = map.get(article.category);
      if (list) list.push(article);
    }
    return map;
  }, [visibleArticles]);

  const totalMatches = visibleArticles.length;

  return (
    <Sheet open={panel.open} onOpenChange={(open) => (!open ? closePanel() : null)}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        data-testid="help-panel"
      >
        <SheetHeader className="border-b border-border/60 p-5">
          <SheetTitle className="text-base">Help centre</SheetTitle>
          <SheetDescription>
            Searchable docs for every part of OP. Press{" "}
            <kbd className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">
              ⌘?
            </kbd>{" "}
            to reopen.
          </SheetDescription>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search articles…"
              data-testid="help-search-input"
              className="h-9 rounded-md pl-8 text-sm"
              aria-label="Search help articles"
            />
          </div>
          <p className="mt-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            {query.trim()
              ? `${totalMatches} result${totalMatches === 1 ? "" : "s"}`
              : `${HELP_ARTICLES.length} articles in ${HELP_CATEGORIES.length} categories`}
          </p>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 overflow-y-auto">
          <nav
            aria-label="Help categories"
            className="hidden w-44 shrink-0 border-r border-border/60 bg-muted/20 p-3 sm:block"
          >
            {HELP_CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const count = grouped.get(cat.id)?.length ?? 0;
              const dim = count === 0 && Boolean(query.trim());
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => {
                    const first = grouped.get(cat.id)?.[0];
                    if (first) {
                      setActiveId(first.id);
                      articleRefs.current
                        .get(first.id)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                  }}
                  className={cn(
                    "hover-elevate active-elevate-2 mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                    dim ? "opacity-40" : "text-foreground",
                  )}
                  data-testid={`help-category-${cat.id}`}
                >
                  <Icon className="h-3.5 w-3.5 text-primary" />
                  <span className="flex-1 truncate">{cat.title}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {count}
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1 px-5 py-5">
            {totalMatches === 0 ? (
              <p className="text-sm text-muted-foreground">
                No articles match &ldquo;{query}&rdquo;. Try a different search.
              </p>
            ) : (
              HELP_CATEGORIES.map((cat) => {
                const articles = grouped.get(cat.id) ?? [];
                if (articles.length === 0) return null;
                return (
                  <section key={cat.id} className="mb-8">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {cat.title}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">
                        {cat.description}
                      </span>
                    </div>
                    <div className="space-y-3">
                      {articles.map((article) => (
                        <article
                          key={article.id}
                          ref={(node) => {
                            articleRefs.current.set(article.id, node);
                          }}
                          data-testid={`help-article-${article.id}`}
                          className={cn(
                            "rounded-lg border p-4 transition-colors",
                            activeId === article.id
                              ? "border-primary/40 bg-primary/5"
                              : "border-border bg-card",
                          )}
                          onClick={() => setActiveId(article.id)}
                        >
                          <h3 className="text-sm font-semibold text-foreground">
                            {article.title}
                          </h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {article.summary}
                          </p>
                          <div className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
                            {article.body.map((p, i) => (
                              <p key={i}>{p}</p>
                            ))}
                          </div>

                          {article.videoUrl ? (
                            <div className="mt-3 flex items-center gap-2 rounded-md border border-dashed border-border p-3 text-[11px] text-muted-foreground">
                              <Video className="h-3.5 w-3.5" />
                              Video walkthrough — opens in your browser.
                            </div>
                          ) : null}

                          {article.links && article.links.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {article.links.map((l) => (
                                <Link
                                  key={l.href}
                                  href={l.href}
                                  onClick={() => closePanel()}
                                  className="hover-elevate active-elevate-2 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
                                  data-testid={`help-article-link-${article.id}-${l.href}`}
                                >
                                  {l.label}
                                  <ArrowRight className="h-3 w-3" />
                                </Link>
                              ))}
                            </div>
                          ) : null}

                          <FeedbackRow
                            articleId={article.id}
                            current={feedback[article.id] ?? null}
                            onPick={(v) => setArticleFeedback(article.id, v)}
                          />
                        </article>
                      ))}
                    </div>
                  </section>
                );
              })
            )}

            <Badge variant="outline" className="mt-4 text-[10px]">
              Looking for the public docs site? Visit /docs from the marketing
              shell.
            </Badge>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FeedbackRow({
  articleId,
  current,
  onPick,
}: {
  articleId: string;
  current: "yes" | "no" | null;
  onPick: (v: "yes" | "no") => void;
}) {
  return (
    <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
      <span className="text-[11px] text-muted-foreground">
        Was this helpful?
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPick("yes")}
          aria-label="Mark helpful"
          data-testid={`help-feedback-yes-${articleId}`}
          className={cn(
            "hover-elevate active-elevate-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground",
            current === "yes" && "bg-primary/10 text-primary",
          )}
        >
          <ThumbsUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => onPick("no")}
          aria-label="Mark unhelpful"
          data-testid={`help-feedback-no-${articleId}`}
          className={cn(
            "hover-elevate active-elevate-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground",
            current === "no" && "bg-destructive/10 text-destructive",
          )}
        >
          <ThumbsDown className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
