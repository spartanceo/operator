import { Link, useParams, useLocation } from "wouter";
import { ArrowLeft, ArrowRight, ArrowDownToLine, Lock, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import { findSkill, reviewsForSkill, skillsByCreator, SKILLS } from "@/lib/marketplace-data";
import NotFound from "@/pages/not-found";

export default function SkillDetailPage() {
  const params = useParams();
  const [, navigate] = useLocation();
  const slug = (params as { slug?: string }).slug ?? "";
  const skill = findSkill(slug);
  if (!skill) return <NotFound />;
  const Icon = skill.icon;
  const reviews = reviewsForSkill(skill.slug);
  const moreFromCreator = skillsByCreator(skill.creatorSlug).filter(
    (s) => s.slug !== skill.slug,
  );
  const otherSkills = SKILLS.filter(
    (s) => s.slug !== skill.slug && s.category === skill.category,
  ).slice(0, 4);

  return (
    <>
      <SEO
        title={skill.name}
        description={skill.tagline}
      />
      <section className="border-b border-border/40 py-12 md:py-16">
        <div className="mx-auto max-w-6xl px-5 md:px-8">
          <button
            type="button"
            onClick={() => navigate("/marketplace")}
            className="hover-elevate inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to marketplace
          </button>
          <div className="mt-8 grid grid-cols-1 gap-10 md:grid-cols-12">
            <div className="md:col-span-8">
              <div className="flex items-start gap-5">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-card text-primary">
                  <Icon className="h-7 w-7" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="rounded-full border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                      {skill.category}
                    </Badge>
                    <span className="text-xs text-muted-foreground">v{skill.versions[0]?.version}</span>
                  </div>
                  <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight md:text-5xl">
                    {skill.name}
                  </h1>
                  <div className="mt-3 text-sm text-muted-foreground">
                    by{" "}
                    <Link href="/creators" className="hover-elevate rounded-md px-1 text-foreground">
                      {skill.creator}
                    </Link>
                  </div>
                </div>
              </div>
              <p className="mt-7 text-balance text-lg leading-relaxed text-foreground">
                {skill.tagline}
              </p>
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
                {skill.description}
              </p>
            </div>
            <div className="md:col-span-4">
              <Card className="overflow-hidden p-0">
                <div className="space-y-4 border-b border-border/60 p-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Star className="h-4 w-4 fill-primary text-primary" />
                      <span className="text-base font-semibold text-foreground">{skill.rating}</span>
                      <span className="text-xs text-muted-foreground">({skill.ratingCount} reviews)</span>
                    </div>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {skill.installs.toLocaleString()} installs
                    </div>
                  </div>
                  <Button asChild className="w-full gap-2" size="lg">
                    <a href={`omninity://install?skill=${skill.slug}`}>
                      <ArrowDownToLine className="h-4 w-4" />
                      Install in OP
                    </a>
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    Opens Omninity Operator on your machine
                  </p>
                </div>
                <div className="p-6">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Permissions it asks for
                  </div>
                  <ul className="mt-3 space-y-2.5">
                    {skill.permissions.map((p) => (
                      <li key={p} className="flex items-start gap-2.5 text-sm text-foreground">
                        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>
      <section className="border-b border-border/40 py-16 md:py-20">
        <div className="mx-auto max-w-6xl px-5 md:px-8">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            What it does, in detail
          </h2>
          <div className="mt-7 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2">
            {skill.features.map((f) => (
              <div key={f} className="bg-card p-6 text-sm leading-relaxed text-foreground">
                <div className="mb-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <ArrowRight className="h-3.5 w-3.5" />
                </div>
                <div>{f}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="border-b border-border/40 py-16 md:py-20">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-5 md:grid-cols-12 md:px-8">
          <div className="md:col-span-7">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">Reviews</h2>
            <div className="mt-7 space-y-4">
              {reviews.map((r, i) => (
                <Card key={i} className="p-6">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-foreground">{r.author}</div>
                    <div className="flex items-center gap-0.5">
                      {Array.from({ length: 5 }).map((_, idx) => (
                        <Star
                          key={idx}
                          className={
                            idx < r.rating
                              ? "h-3.5 w-3.5 fill-primary text-primary"
                              : "h-3.5 w-3.5 text-muted-foreground/40"
                          }
                        />
                      ))}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{r.date}</div>
                  <div className="mt-3 text-sm leading-relaxed text-foreground">{r.body}</div>
                </Card>
              ))}
            </div>
          </div>
          <div className="md:col-span-5">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">Version history</h2>
            <Card className="mt-7 divide-y divide-border/60 p-0">
              {skill.versions.map((v) => (
                <div key={v.version} className="p-5">
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-sm text-foreground">v{v.version}</div>
                    <div className="text-xs text-muted-foreground">{v.date}</div>
                  </div>
                  <div className="mt-2 text-sm text-muted-foreground">{v.notes}</div>
                </div>
              ))}
            </Card>
          </div>
        </div>
      </section>
      <section className="py-16 md:py-20">
        <div className="mx-auto max-w-6xl px-5 md:px-8">
          <div className="flex items-baseline justify-between">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
              {moreFromCreator.length > 0
                ? `More from ${skill.creator}`
                : `Other ${skill.category} skills`}
            </h2>
            <Button variant="ghost" size="sm" asChild className="gap-1.5">
              <Link href="/marketplace">
                Browse all
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
          <div className="mt-7 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
            {(moreFromCreator.length > 0 ? moreFromCreator : otherSkills)
              .slice(0, 4)
              .map((s) => {
                const ICon = s.icon;
                return (
                  <Link
                    key={s.slug}
                    href={`/marketplace/${s.slug}`}
                    className="block hover-elevate"
                  >
                    <Card className="flex h-full flex-col p-5">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background text-primary">
                        <ICon className="h-4 w-4" />
                      </div>
                      <div className="mt-4 text-sm font-medium tracking-tight">{s.name}</div>
                      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {s.tagline}
                      </div>
                    </Card>
                  </Link>
                );
              })}
          </div>
        </div>
      </section>
    </>
  );
}
