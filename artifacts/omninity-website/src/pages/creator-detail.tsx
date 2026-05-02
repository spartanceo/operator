import { Link, useParams } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Download, Star, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import { TOP_CREATORS } from "@/lib/site-data";
import { SKILLS } from "@/lib/marketplace-data";
import NotFound from "./not-found";

function formatUSD(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export default function CreatorDetailPage() {
  const params = useParams() as { slug?: string };
  const creator = TOP_CREATORS.find((c) => c.slug === params.slug);
  if (!creator) return <NotFound />;

  const list = SKILLS.filter(
    (s) => s.creator === creator.name || s.creatorSlug === creator.slug,
  );
  const totalInstalls = list.reduce((sum, s) => sum + s.installs, 0);
  const avgRating =
    list.length > 0
      ? list.reduce((sum, s) => sum + s.rating, 0) / list.length
      : 0;

  return (
    <>
      <SEO
        title={`${creator.name} · Creator`}
        description={`${creator.name} (${creator.handle}) on Omninity Operator. ${creator.bio}`}
      />
      <section className="border-b border-border/40 py-16 md:py-20">
        <div className="mx-auto max-w-6xl px-5 md:px-8">
          <Link
            href="/creators"
            className="hover-elevate inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to creators
          </Link>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            className="mt-8 grid grid-cols-1 gap-8 md:grid-cols-12 md:items-end"
          >
            <div className="md:col-span-8">
              <div className="flex items-center gap-5">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-card text-xl font-medium tracking-tight text-foreground">
                  {creator.initials}
                </div>
                <div>
                  <Badge
                    variant="outline"
                    className="rounded-full border-border bg-card/60 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                  >
                    Verified creator
                  </Badge>
                  <h1 className="mt-2 text-balance text-4xl font-semibold tracking-tight md:text-5xl">
                    {creator.name}
                  </h1>
                  <div className="mt-1 font-mono text-sm text-muted-foreground">
                    {creator.handle}
                  </div>
                </div>
              </div>
              <p className="mt-6 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground">
                {creator.bio}
              </p>
            </div>
            <div className="md:col-span-4">
              <Card className="p-6">
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">
                      Skills
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                      {list.length}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">
                      Installs
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                      {totalInstalls >= 1000
                        ? `${(totalInstalls / 1000).toFixed(1)}k`
                        : totalInstalls.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">
                      Rating
                    </div>
                    <div className="mt-1 flex items-baseline gap-1">
                      <Star className="h-4 w-4 fill-primary text-primary" />
                      <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                        {avgRating.toFixed(1)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-5 flex items-center gap-2 border-t border-border/60 pt-5 text-sm text-muted-foreground">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  Earned {formatUSD(creator.monthlyEarnings)} last month
                </div>
              </Card>
            </div>
          </motion.div>
        </div>
      </section>
      <section className="py-16 md:py-20">
        <div className="mx-auto max-w-6xl px-5 md:px-8">
          <div className="flex items-end justify-between">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Skills by {creator.name}
            </h2>
            <Button variant="ghost" size="sm" asChild className="gap-1.5">
              <Link href="/marketplace">
                Browse the marketplace
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
          <div className="mt-7 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {list.map((skill) => (
              <Link key={skill.slug} href={`/marketplace/${skill.slug}`}>
                <Card className="group hover-elevate flex h-full cursor-pointer flex-col gap-4 p-6 transition-colors">
                  <div className="flex items-start justify-between">
                    <Badge
                      variant="outline"
                      className="rounded-full border-border bg-card/60 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      {skill.category}
                    </Badge>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Star className="h-3.5 w-3.5 fill-primary text-primary" />
                      <span className="tabular-nums">{skill.rating.toFixed(1)}</span>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-lg font-medium tracking-tight text-foreground">
                      {skill.name}
                    </h3>
                    <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                      {skill.tagline}
                    </p>
                  </div>
                  <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Download className="h-3.5 w-3.5" />
                      <span className="tabular-nums">
                        {skill.installs.toLocaleString()}
                      </span>
                    </span>
                    <span className="font-mono">v{skill.versions[0]?.version ?? "1.0.0"}</span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
