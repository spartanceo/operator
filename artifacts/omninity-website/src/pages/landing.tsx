import { useEffect, useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowDownToLine,
  CheckCircle2,
  ChevronRight,
  CornerDownRight,
  Cpu,
  Eye,
  ShieldCheck,
  Star,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import { CORE_POWERS, TESTIMONIALS, PRICING_TIERS } from "@/lib/site-data";
import { SKILLS } from "@/lib/marketplace-data";

const TYPED_LINES = [
  { prompt: "you", text: "open my mail, file the noise" },
  { prompt: "op", text: "reading inbox via Apple Mail.app — 247 messages", muted: true },
  { prompt: "op", text: "filed 198 newsletters, drafted 11 replies for review", muted: true },
  { prompt: "op", text: "12 messages need your attention. shall I show them?", accent: true },
];

function Terminalette() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => (t + 1) % (TYPED_LINES.length + 1)), 1400);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
      <div className="flex items-center gap-2 border-b border-border/70 bg-background/40 px-4 py-2.5">
        <div className="h-2.5 w-2.5 rounded-full bg-muted" />
        <div className="h-2.5 w-2.5 rounded-full bg-muted" />
        <div className="h-2.5 w-2.5 rounded-full bg-muted" />
        <div className="ml-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          op — quiet morning routine
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" /> local
        </div>
      </div>
      <div className="space-y-2.5 p-6 font-mono text-[13px] leading-relaxed">
        {TYPED_LINES.slice(0, tick).map((line, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="flex items-start gap-3"
          >
            <span
              className={
                line.prompt === "you"
                  ? "select-none text-muted-foreground"
                  : "select-none text-primary"
              }
            >
              {line.prompt} ›
            </span>
            <span
              className={
                line.muted
                  ? "text-muted-foreground"
                  : line.accent
                  ? "text-foreground"
                  : "text-foreground"
              }
            >
              {line.text}
            </span>
          </motion.div>
        ))}
        <div className="flex items-center gap-3">
          <span className="select-none text-muted-foreground">you ›</span>
          <span className="inline-block h-4 w-1.5 animate-pulse bg-primary" />
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-border/70 bg-background/40 px-4 py-2.5 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="h-3 w-3" /> llama3.2:7b · local
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3" /> network: deny
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
          approval gate active
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border/40">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 12% 0%, hsl(var(--primary) / 0.10), transparent 60%), radial-gradient(40% 50% at 100% 30%, hsl(var(--primary) / 0.06), transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(0 0% 100% / 0.04) 1px, transparent 1px), linear-gradient(90deg, hsl(0 0% 100% / 0.04) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage:
            "radial-gradient(ellipse at center, black 30%, transparent 80%)",
        }}
      />
      <div className="relative mx-auto grid max-w-7xl grid-cols-1 gap-14 px-5 pb-24 pt-20 md:grid-cols-12 md:gap-16 md:px-8 md:pb-32 md:pt-28">
        <div className="md:col-span-7">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
          >
            <Badge
              variant="outline"
              className="gap-2 rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
              Local. Private. Yours.
            </Badge>
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.05 }}
            className="mt-6 text-balance text-5xl font-semibold leading-[1.05] tracking-tight md:text-6xl lg:text-7xl"
          >
            Your computer{" "}
            <span className="text-primary">becomes</span>{" "}
            an autonomous{" "}
            <br className="hidden md:block" />
            agent.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.12 }}
            className="mt-7 max-w-xl text-balance text-lg leading-relaxed text-muted-foreground"
          >
            Omninity Operator is a desktop agent that drives every application on your
            machine, runs entirely on your own hardware, and asks before it acts.
            No cloud round-trip. No data exhaust. No surprises.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.18 }}
            className="mt-9 flex flex-wrap items-center gap-3"
          >
            <Button size="lg" asChild className="gap-2">
              <Link href="/download">
                <ArrowDownToLine className="h-4 w-4" />
                Download for Mac and Windows
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="gap-2">
              <Link href="/marketplace">
                Browse 200+ skills
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </motion.div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.55, delay: 0.3 }}
            className="mt-10 grid max-w-xl grid-cols-3 gap-6 border-t border-border/60 pt-7"
          >
            {[
              { kpi: "0", label: "bytes leave by default" },
              { kpi: "200+", label: "community skills" },
              { kpi: "1-click", label: "to undo any action" },
            ].map((s) => (
              <div key={s.label}>
                <div className="text-3xl font-semibold tabular-nums text-foreground">
                  {s.kpi}
                </div>
                <div className="mt-1.5 text-xs leading-snug text-muted-foreground">
                  {s.label}
                </div>
              </div>
            ))}
          </motion.div>
        </div>
        <div className="md:col-span-5">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            <Terminalette />
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function Manifesto() {
  return (
    <section className="border-b border-border/40 py-24 md:py-32">
      <div className="mx-auto max-w-7xl px-5 md:px-8">
        <div className="grid grid-cols-1 gap-16 md:grid-cols-12">
          <div className="md:col-span-5">
            <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Manifesto
            </Badge>
            <h2 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              Software that is loyal to <span className="text-primary">you</span>.
            </h2>
            <p className="mt-6 text-balance text-base leading-relaxed text-muted-foreground">
              The first decade of consumer AI taught us a lesson the hard way: agents
              that live on someone else's server work for someone else.
            </p>
            <p className="mt-4 text-balance text-base leading-relaxed text-muted-foreground">
              OP is the alternative. Your data stays on your disk. Your model runs on
              your silicon. Your decisions stay yours.
            </p>
          </div>
          <div className="md:col-span-7">
            <div className="space-y-px overflow-hidden rounded-xl border border-border bg-card">
              {[
                {
                  title: "No action without your approval.",
                  body: "Every step that touches the world stops at a gate. You see the diff before it lands.",
                },
                {
                  title: "No data leaves the device.",
                  body: "Network access is opt-in per skill, per session. The default posture is air-gapped.",
                },
                {
                  title: "Every action is reversible.",
                  body: "OP keeps a transactional log. Undo any single step, or roll back the whole chain.",
                },
              ].map((row, i) => (
                <div key={i} className="flex gap-5 border-b border-border/60 p-7 last:border-0">
                  <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-lg font-medium tracking-tight">{row.title}</div>
                    <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {row.body}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CorePowers() {
  return (
    <section className="border-b border-border/40 py-24 md:py-32">
      <div className="mx-auto max-w-7xl px-5 md:px-8">
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              The ten powers
            </Badge>
            <h2 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              Built to do real work, quietly.
            </h2>
          </div>
          <p className="max-w-md text-base leading-relaxed text-muted-foreground">
            OP is not a chat box with delusions of agency. It is a careful, opinionated
            runtime for the routine work you'd rather hand off.
          </p>
        </div>
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-50px" }}
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.04 } },
          }}
          className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-5"
        >
          {CORE_POWERS.map((power) => {
            const Icon = power.icon;
            return (
              <motion.div
                key={power.title}
                variants={{
                  hidden: { opacity: 0, y: 8 },
                  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
                }}
                className="group relative bg-card p-7"
              >
                <div className="mb-5 flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="text-base font-medium tracking-tight">{power.title}</div>
                <div className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {power.body}
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="border-b border-border/40 py-24 md:py-32">
      <div className="mx-auto max-w-7xl px-5 md:px-8">
        <div className="max-w-2xl">
          <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            How it works
          </Badge>
          <h2 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Three steps to your computer thinking with you.
          </h2>
        </div>
        <div className="mt-14 grid grid-cols-1 gap-7 lg:grid-cols-3">
          {[
            {
              num: "01",
              title: "Download OP",
              body: "One installer for Mac and Windows. The first run pulls a 4GB local model via Ollama and you're set.",
              icon: ArrowDownToLine,
            },
            {
              num: "02",
              title: "Pick a few skills",
              body: "From the marketplace, install the routines you'd actually use today. Inbox triage, weekly review, deploy shepherd.",
              icon: Eye,
            },
            {
              num: "03",
              title: "Hand off the routine",
              body: "Talk to your computer the way you'd talk to a careful intern. OP asks before every step that matters.",
              icon: Cpu,
            },
          ].map((step) => {
            const Icon = step.icon;
            return (
              <Card key={step.num} className="overflow-hidden p-8">
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
  );
}

function SkillOfTheDay() {
  const skill = SKILLS.find((s) => s.slug === "code-review-companion") ?? SKILLS[0]!;
  const Icon = skill.icon;
  return (
    <section className="border-b border-border/40 py-24 md:py-32">
      <div className="mx-auto max-w-7xl px-5 md:px-8">
        <div className="grid grid-cols-1 gap-12 md:grid-cols-12 md:gap-16">
          <div className="md:col-span-5">
            <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Skill of the day
            </Badge>
            <h2 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              Real work, made by real makers.
            </h2>
            <p className="mt-5 text-balance text-base leading-relaxed text-muted-foreground">
              Skills are small, focused, reviewed bundles of intent. Anyone can write one.
              The ones that work end up in the marketplace, signed and versioned.
            </p>
            <div className="mt-7 flex items-center gap-3">
              <Button variant="outline" asChild className="gap-2">
                <Link href="/marketplace">
                  Browse the marketplace
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button variant="ghost" asChild className="gap-2">
                <Link href="/creators">
                  Become a creator
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
          <div className="md:col-span-7">
            <Link
              href={`/marketplace/${skill.slug}`}
              className="block hover-elevate overflow-hidden rounded-2xl border border-border bg-card"
            >
              <div className="border-b border-border/70 bg-background/30 p-7">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-card text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-medium tracking-tight">{skill.name}</span>
                      <Badge variant="outline" className="rounded-full border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                        {skill.category}
                      </Badge>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      by {skill.creator} · {skill.installs.toLocaleString()} installs
                    </div>
                  </div>
                  <div className="hidden items-center gap-1.5 text-sm font-medium text-foreground sm:flex">
                    <Star className="h-4 w-4 fill-primary text-primary" />
                    {skill.rating}
                  </div>
                </div>
                <div className="mt-5 text-base leading-relaxed text-foreground">
                  "{skill.tagline}"
                </div>
              </div>
              <div className="grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                {skill.features.slice(0, 4).map((f) => (
                  <div key={f} className="flex items-start gap-3 p-5 text-sm text-muted-foreground">
                    <CornerDownRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Testimonials() {
  return (
    <section className="border-b border-border/40 py-24 md:py-32">
      <div className="mx-auto max-w-7xl px-5 md:px-8">
        <div className="max-w-2xl">
          <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            From the people running it
          </Badge>
          <h2 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Used quietly, every day.
          </h2>
        </div>
        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {TESTIMONIALS.map((t) => (
            <Card key={t.handle} className="flex h-full flex-col p-7">
              <div className="text-base leading-relaxed text-foreground">"{t.quote}"</div>
              <div className="mt-auto flex items-center gap-3 pt-7">
                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground">
                  {t.name.split(" ").map((n) => n[0]).join("")}
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">{t.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t.handle} · {t.role}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingTeaser() {
  return (
    <section className="border-b border-border/40 py-24 md:py-32">
      <div className="mx-auto max-w-7xl px-5 md:px-8">
        <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Pricing
            </Badge>
            <h2 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              Free for people. Fair for creators.
            </h2>
          </div>
          <Button variant="ghost" asChild className="gap-2">
            <Link href="/pricing">
              See the full comparison
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
          {PRICING_TIERS.map((tier) => (
            <Card
              key={tier.name}
              className={
                tier.highlight
                  ? "relative overflow-hidden border-primary/40 bg-card p-8"
                  : "p-8"
              }
            >
              {tier.highlight ? (
                <div className="absolute right-0 top-0 rounded-bl-md bg-primary px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-primary-foreground">
                  Most popular
                </div>
              ) : null}
              <div className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                {tier.name}
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-4xl font-semibold tracking-tight">{tier.price}</span>
                {tier.cadence ? (
                  <span className="text-sm text-muted-foreground">{tier.cadence}</span>
                ) : null}
              </div>
              <div className="mt-2 text-sm text-muted-foreground">{tier.tagline}</div>
              <Button
                asChild
                className="mt-6 w-full"
                variant={tier.highlight ? "default" : "outline"}
              >
                <Link href={tier.ctaHref}>{tier.cta}</Link>
              </Button>
              <ul className="mt-7 space-y-3">
                {tier.features.slice(0, 4).map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-5xl px-5 md:px-8">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-card p-10 md:p-16">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(60% 90% at 100% 0%, hsl(var(--primary) / 0.18), transparent 65%), radial-gradient(40% 60% at 0% 100%, hsl(var(--primary) / 0.08), transparent 60%)",
            }}
          />
          <div className="relative flex flex-col items-start gap-8 md:flex-row md:items-center md:justify-between">
            <div className="max-w-xl">
              <h2 className="text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
                Take your computer back.
              </h2>
              <p className="mt-4 text-balance text-base leading-relaxed text-muted-foreground">
                OP is free for personal use, forever. The download is 96 MB. The first
                local model is 4 GB. Everything else stays between you and your machine.
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row md:flex-col lg:flex-row">
              <Button size="lg" asChild className="w-full gap-2 sm:w-auto">
                <Link href="/download">
                  <ArrowDownToLine className="h-4 w-4" />
                  Download OP
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild className="w-full gap-2 sm:w-auto">
                <Link href="/docs">
                  Read the docs
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function LandingPage() {
  return (
    <>
      <SEO
        title="The private operating layer for your computer"
        description="Omninity Operator is a local-first desktop agent that drives every application on your machine, runs entirely on your own hardware via Ollama, and asks before it acts."
        ogTags
      />
      <Hero />
      <Manifesto />
      <CorePowers />
      <HowItWorks />
      <SkillOfTheDay />
      <Testimonials />
      <PricingTeaser />
      <FinalCta />
    </>
  );
}
