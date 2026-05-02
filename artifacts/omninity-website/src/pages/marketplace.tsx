import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Search, Star, Filter as FilterIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SEO } from "@/components/seo";
import { CATEGORIES, SKILLS, type SkillCategory } from "@/lib/marketplace-data";
import { cn } from "@/lib/utils";

type Sort = "popular" | "top" | "newest";

export default function MarketplacePage() {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<SkillCategory | "All">("All");
  const [sort, setSort] = useState<Sort>("popular");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let filtered = SKILLS.filter((s) => {
      const matchesCat = activeCategory === "All" || s.category === activeCategory;
      const matchesQuery =
        q === "" ||
        s.name.toLowerCase().includes(q) ||
        s.tagline.toLowerCase().includes(q) ||
        s.creator.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q);
      return matchesCat && matchesQuery;
    });
    if (sort === "popular") filtered = [...filtered].sort((a, b) => b.installs - a.installs);
    if (sort === "top") filtered = [...filtered].sort((a, b) => b.rating - a.rating);
    if (sort === "newest")
      filtered = [...filtered].sort((a, b) => {
        const ad = a.versions[0]?.date ?? "";
        const bd = b.versions[0]?.date ?? "";
        return bd.localeCompare(ad);
      });
    return filtered;
  }, [query, activeCategory, sort]);

  return (
    <>
      <SEO
        title="Skill marketplace"
        description="Browse hundreds of community-built skills for Omninity Operator. Local-first agents that do real work without leaving your machine."
      />
      <section className="border-b border-border/40 py-16 md:py-20">
        <div className="mx-auto max-w-7xl px-5 md:px-8">
          <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Marketplace
          </Badge>
          <h1 className="mt-6 text-balance text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            Skills, made by people.
          </h1>
          <p className="mt-5 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground">
            Each skill is a small, reviewed bundle of intent. Install one, and OP starts
            doing that one quiet thing for you. Combine many, and your computer becomes
            something else entirely.
          </p>
          <div className="mt-10 flex flex-col items-stretch gap-3 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills, creators, intents..."
                className="h-11 bg-card pl-10"
              />
            </div>
            <div className="flex items-center gap-2">
              <FilterIcon className="h-4 w-4 text-muted-foreground" />
              <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                <SelectTrigger className="h-11 w-[180px] bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="popular">Most popular</SelectItem>
                  <SelectItem value="top">Top rated</SelectItem>
                  <SelectItem value="newest">Newest</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {(["All", ...CATEGORIES] as const).map((c) => (
              <button
                key={c}
                onClick={() => setActiveCategory(c)}
                className={cn(
                  "hover-elevate rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors",
                  activeCategory === c
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground",
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="py-12 md:py-16">
        <div className="mx-auto max-w-7xl px-5 md:px-8">
          <div className="mb-6 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {visible.length} skill{visible.length === 1 ? "" : "s"}
              {activeCategory !== "All" ? ` in ${activeCategory}` : ""}
            </span>
          </div>
          {visible.length === 0 ? (
            <Card className="p-12 text-center">
              <div className="text-base text-muted-foreground">
                No skills match that search yet.
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((skill) => {
                const Icon = skill.icon;
                return (
                  <Link
                    key={skill.slug}
                    href={`/marketplace/${skill.slug}`}
                    className="group block hover-elevate"
                  >
                    <Card className="flex h-full flex-col p-6">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-background text-primary">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <Star className="h-3.5 w-3.5 fill-primary text-primary" />
                          <span className="text-foreground">{skill.rating}</span>
                          <span className="text-xs">({skill.ratingCount})</span>
                        </div>
                      </div>
                      <div className="mt-5 text-base font-medium tracking-tight">
                        {skill.name}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        by {skill.creator}
                      </div>
                      <div className="mt-3 line-clamp-3 flex-1 text-sm leading-relaxed text-muted-foreground">
                        {skill.tagline}
                      </div>
                      <div className="mt-5 flex items-center justify-between border-t border-border/60 pt-4">
                        <Badge
                          variant="outline"
                          className="rounded-full border-border text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                        >
                          {skill.category}
                        </Badge>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {skill.installs.toLocaleString()} installs
                        </span>
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
