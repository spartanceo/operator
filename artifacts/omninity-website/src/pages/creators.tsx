import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowRight, BadgeDollarSign, GitBranch, Megaphone, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import { TOP_CREATORS } from "@/lib/site-data";

const STEPS = [
  {
    num: "01",
    title: "Build a skill",
    body: "Use the OP SDK to write a skill in TypeScript. Most useful skills are under 500 lines.",
    icon: Sparkles,
  },
  {
    num: "02",
    title: "Publish to the marketplace",
    body: "Run `op publish`. Your skill is signed, reviewed within 2 business days, and listed.",
    icon: GitBranch,
  },
  {
    num: "03",
    title: "Earn from day one",
    body: "Free or paid. You set the price; you keep 80%. Payouts monthly, no minimum.",
    icon: BadgeDollarSign,
  },
];

export default function CreatorsPage() {
  return (
    <>
      <SEO
        title="For creators"
        description="Build skills for Omninity Operator. Publish to a marketplace of motivated buyers, keep 80% of revenue, own your audience forever."
      />
      <section className="relative overflow-hidden border-b border-border/40 py-24 md:py-32">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(50% 60% at 80% 0%, rgba(255,107,0,0.10), transparent 60%)",
          }}
        />
        <div className="relative mx-auto max-w-7xl px-5 md:px-8">
          <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            For creators
          </Badge>
          <h1 className="mt-6 max-w-4xl text-balance text-5xl font-semibold leading-tight tracking-tight md:text-7xl">
            Build skills.{" "}
            <span className="text-primary">Earn revenue.</span>{" "}
            Keep your audience.
          </h1>
          <p className="mt-6 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground">
            The first marketplace where independent makers can publish autonomous-agent
            skills, get paid fairly, and own the relationship with the people who use
            their work.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button size="lg" asChild className="gap-2">
              <Link href="/pricing">
                Become a creator
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="gap-2">
              <Link href="/docs/skills/writing-a-skill">
                Read the SDK
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
          <div className="mt-14 grid max-w-3xl grid-cols-3 gap-8 border-t border-border/60 pt-9">
            {[
              { kpi: "80%", label: "revenue share, no tiers" },
              { kpi: "2 days", label: "to first publish" },
              { kpi: "$84k", label: "earned by top creator last month" },
            ].map((s) => (
              <div key={s.label}>
                <div className="text-3xl font-semibold tabular-nums text-foreground md:text-4xl">
                  {s.kpi}
                </div>
                <div className="mt-1.5 text-xs leading-snug text-muted-foreground md:text-sm">
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="border-b border-border/40 py-24 md:py-32">
        <div className="mx-auto max-w-7xl px-5 md:px-8">
          <div className="grid grid-cols-1 gap-10 md:grid-cols-12 md:gap-16">
            <div className="md:col-span-5">
              <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                The deal
              </Badge>
              <h2 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
                A model that respects what you built.
              </h2>
              <p className="mt-5 text-balance text-base leading-relaxed text-muted-foreground">
                You set the price. We take 20% to keep the marketplace honest, signed,
                and well-lit. The other 80% lands in your account every month.
              </p>
              <p className="mt-3 text-balance text-base leading-relaxed text-muted-foreground">
                We don't change your skill, we don't pull it without telling you, and we
                don't insert ads or upsells anywhere near your work.
              </p>
            </div>
            <div className="md:col-span-7">
              <div className="space-y-px overflow-hidden rounded-2xl border border-border bg-card">
                {[
                  { label: "List price (yours)", value: "$5.00" },
                  { label: "OP marketplace fee (20%)", value: "$1.00" },
                  { label: "Payment processing", value: "$0.30" },
                  {
                    label: "You receive",
                    value: "$3.70",
                    accent: true,
                  },
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between border-b border-border/60 p-6 last:border-0"
                  >
                    <span className={row.accent ? "text-base font-medium text-foreground" : "text-sm text-muted-foreground"}>
                      {row.label}
                    </span>
                    <span
                      className={
                        row.accent
                          ? "text-2xl font-semibold tabular-nums text-primary"
                          : "text-base font-medium tabular-nums text-foreground"
                      }
                    >
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                Example based on a single $5 sale. Multi-skill bundles, free skills, and
                enterprise volume deals follow the same 80/20 split.
              </p>
            </div>
          </div>
        </div>
      </section>
      <section className="border-b border-border/40 py-24 md:py-32">
        <div className="mx-auto max-w-7xl px-5 md:px-8">
          <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Three steps
          </Badge>
          <h2 className="mt-5 max-w-3xl text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            From idea to earning, in an evening.
          </h2>
          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
            {STEPS.map((step) => {
              const Icon = step.icon;
              return (
                <Card key={step.num} className="p-8">
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-xs tracking-widest text-muted-foreground">
                      {step.num}
                    </div>
                    <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                  </div>
                  <div className="mt-6 text-xl font-medium tracking-tight">{step.title}</div>
                  <div className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                    {step.body}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      </section>
      <section className="border-b border-border/40 py-24 md:py-32">
        <div className="mx-auto max-w-7xl px-5 md:px-8">
          <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
            <div className="max-w-2xl">
              <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Top creators
              </Badge>
              <h2 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
                Real makers, building real things.
              </h2>
            </div>
            <Button variant="ghost" asChild className="gap-2">
              <Link href="/marketplace">
                Browse the marketplace
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-50px" }}
            variants={{
              hidden: {},
              visible: { transition: { staggerChildren: 0.05 } },
            }}
            className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3"
          >
            {TOP_CREATORS.map((c) => (
              <motion.div
                key={c.slug}
                variants={{
                  hidden: { opacity: 0, y: 8 },
                  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
                }}
              >
                <Card className="flex h-full flex-col p-7">
                  <Link
                    href={`/creators/${c.slug}`}
                    className="flex items-center gap-4"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-background text-sm font-medium text-foreground">
                      {c.initials}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-base font-medium text-foreground underline-offset-4 hover:underline">
                        {c.name}
                      </div>
                      <div className="text-xs text-muted-foreground">{c.handle}</div>
                    </div>
                  </Link>
                  <p className="mt-5 text-sm leading-relaxed text-muted-foreground">{c.bio}</p>
                  <div className="mt-6 grid grid-cols-2 gap-3 border-t border-border/60 pt-5">
                    <div>
                      <div className="text-xs uppercase tracking-wider text-muted-foreground">
                        Last 30 days
                      </div>
                      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                        ${c.monthlyEarnings.toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wider text-muted-foreground">
                        Top skill
                      </div>
                      <Link
                        href={`/marketplace/${c.topSkillSlug}`}
                        className="mt-1 block text-sm text-foreground underline-offset-4 hover:underline"
                      >
                        {c.topSkill}
                      </Link>
                    </div>
                  </div>
                  <Link
                    href={`/creators/${c.slug}`}
                    className="mt-5 inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                  >
                    View profile
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>
      <section className="py-24 md:py-32">
        <div className="mx-auto max-w-5xl px-5 md:px-8">
          <div className="relative overflow-hidden rounded-3xl border border-border bg-card p-10 md:p-16">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(60% 90% at 0% 0%, rgba(255,107,0,0.16), transparent 65%)",
              }}
            />
            <div className="relative flex flex-col items-start gap-6 md:flex-row md:items-center md:justify-between">
              <div className="max-w-xl">
                <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-primary">
                  <Megaphone className="h-4 w-4" />
                </div>
                <h2 className="text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
                  Start building today.
                </h2>
                <p className="mt-4 text-balance text-base leading-relaxed text-muted-foreground">
                  The SDK is free. The first publish is free. The marketplace fee only
                  kicks in when your skill earns money.
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
                <Button size="lg" asChild className="w-full gap-2 sm:w-auto">
                  <Link href="/docs/skills/writing-a-skill">
                    Open the SDK
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button size="lg" variant="outline" asChild className="w-full gap-2 sm:w-auto">
                  <Link href="/marketplace">See what people built</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
