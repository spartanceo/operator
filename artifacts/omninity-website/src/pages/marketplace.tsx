import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  Search,
  Star,
  Filter as FilterIcon,
  Sparkles,
  Layers,
} from "lucide-react";
import { useListSkills, type Skill as ApiSkill } from "@workspace/api-client-react";
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
import {
  CATEGORIES as SEED_CATEGORIES,
  SKILLS as SEED_SKILLS,
  type Skill as SeedSkill,
  type SkillCategory,
} from "@/lib/marketplace-data";
import { cn } from "@/lib/utils";

type Sort = "popular" | "top" | "newest";

// tier-review: bounded — fixed enum of model families the marketplace targets
const MODEL_TABS = [
  "all",
  "llama3.1",
  "qwen2.5",
  "mistral",
  "phi3",
  "gemma2",
];

interface DisplaySkill {
  slug: string;
  name: string;
  creator: string;
  creatorSlug: string;
  category: string;
  tagline: string;
  description: string;
  rating: number;
  ratingCount: number;
  installs: number;
  installedAt: number;
  modelTags: string[];
  source: "api" | "seed";
  seedRef: SeedSkill | null;
  version: string;
  lastUpdated: number;
  unmaintained: boolean;
}

// 12 months — matches the server-side UNMAINTAINED_THRESHOLD_MS so the badge
// is consistent between the operator UI and the public marketplace.
const UNMAINTAINED_THRESHOLD_MS = 365 * 24 * 60 * 60 * 1000;

function fromApi(s: ApiSkill): DisplaySkill {
  const publishedAt = new Date(s.publishedAt).getTime();
  return {
    slug: s.slug,
    name: s.name,
    creator: s.author,
    creatorSlug: s.author.toLowerCase().replace(/\s+/g, "-"),
    category: s.category,
    tagline: s.description || "Local-first skill installed in your tenant.",
    description: s.content.slice(0, 240),
    rating: 4.8,
    ratingCount: s.installCount,
    installs: s.installCount,
    installedAt: new Date(s.createdAt).getTime(),
    modelTags: s.modelTags,
    source: "api",
    seedRef: null,
    version: s.latestVersion,
    lastUpdated: publishedAt,
    unmaintained: s.unmaintained,
  };
}

function fromSeed(s: SeedSkill): DisplaySkill {
  const lastVersion = s.versions[0];
  const lastUpdated = new Date(lastVersion?.date ?? "2025-01-01").getTime();
  return {
    slug: s.slug,
    name: s.name,
    creator: s.creator,
    creatorSlug: s.creatorSlug,
    category: s.category,
    tagline: s.tagline,
    description: s.description,
    rating: s.rating,
    ratingCount: s.ratingCount,
    installs: s.installs,
    installedAt: lastUpdated,
    // Seed skills have no model tags; default to a broad set so they survive
    // model-tab filtering in the "All" position.
    modelTags: ["llama3.1", "qwen2.5"],
    source: "seed",
    seedRef: s,
    version: lastVersion?.version ?? "1.0.0",
    lastUpdated,
    unmaintained: Date.now() - lastUpdated > UNMAINTAINED_THRESHOLD_MS,
  };
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "today";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
}

export default function MarketplacePage() {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<SkillCategory | "All">("All");
  const [activeModel, setActiveModel] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("popular");

  // We surface real installed-or-imported skills from the API alongside the
  // seed catalogue so the marketplace stays useful before any DB rows exist.
  const apiQuery = useListSkills({ limit: 100 });
  const apiSkills = apiQuery.data?.data.items ?? [];

  const visible = useMemo(() => {
    const apiDisplay = apiSkills.map(fromApi);
    const apiSlugs = new Set(apiDisplay.map((s) => s.slug));
    const seedDisplay = SEED_SKILLS.filter((s) => !apiSlugs.has(s.slug)).map(
      fromSeed,
    );
    const merged = [...apiDisplay, ...seedDisplay];

    const q = query.trim().toLowerCase();
    let filtered = merged.filter((s) => {
      const matchesCat = activeCategory === "All" || s.category === activeCategory;
      const matchesModel =
        activeModel === "all" ||
        s.modelTags.some((t) => t.toLowerCase().includes(activeModel));
      const matchesQuery =
        q === "" ||
        s.name.toLowerCase().includes(q) ||
        s.tagline.toLowerCase().includes(q) ||
        s.creator.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q);
      return matchesCat && matchesModel && matchesQuery;
    });
    if (sort === "popular") filtered = [...filtered].sort((a, b) => b.installs - a.installs);
    if (sort === "top") filtered = [...filtered].sort((a, b) => b.rating - a.rating);
    if (sort === "newest") filtered = [...filtered].sort((a, b) => b.installedAt - a.installedAt);
    return filtered;
  }, [apiSkills, query, activeCategory, activeModel, sort]);

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
                data-testid="input-marketplace-search"
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
            {(["All", ...SEED_CATEGORIES] as const).map((c) => (
              <button
                key={c}
                onClick={() => setActiveCategory(c)}
                data-testid={`category-tab-${c}`}
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
          <div
            className="mt-3 flex flex-wrap items-center gap-2"
            data-testid="model-tabs"
          >
            <span className="mr-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Model
            </span>
            {MODEL_TABS.map((m) => (
              <button
                key={m}
                onClick={() => setActiveModel(m)}
                data-testid={`model-tab-${m}`}
                className={cn(
                  "hover-elevate rounded-full border px-3 py-1 text-xs",
                  activeModel === m
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground",
                )}
              >
                {m === "all" ? "All models" : m}
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
              {activeModel !== "all" ? ` for ${activeModel}` : ""}
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
                const Icon = skill.seedRef?.icon ?? Sparkles;
                return (
                  <Link
                    key={`${skill.source}-${skill.slug}`}
                    href={`/marketplace/${skill.slug}`}
                    className="group block hover-elevate"
                    data-testid={`marketplace-card-${skill.slug}`}
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
                      <div className="mt-5 flex flex-wrap items-center gap-2 text-base font-medium tracking-tight">
                        {skill.name}
                        {skill.source === "api" ? (
                          <Badge
                            variant="outline"
                            className="rounded-full border-primary/30 px-2 py-0 text-[9px] uppercase tracking-wider text-primary"
                          >
                            <Layers className="mr-1 h-2.5 w-2.5" /> Local
                          </Badge>
                        ) : null}
                        {skill.unmaintained ? (
                          <Badge
                            variant="outline"
                            className="rounded-full border-amber-500/40 bg-amber-500/10 px-2 py-0 text-[9px] uppercase tracking-wider text-amber-600"
                            data-testid={`badge-unmaintained-${skill.slug}`}
                          >
                            Unmaintained
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>by {skill.creator}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className="font-mono"
                          data-testid={`version-${skill.slug}`}
                        >
                          v{skill.version}
                        </span>
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
                        <div className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
                          <span data-testid={`last-updated-${skill.slug}`}>
                            Updated {formatRelative(skill.lastUpdated)}
                          </span>
                          <span>{skill.installs.toLocaleString()} installs</span>
                        </div>
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
