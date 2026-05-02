import { Link } from "wouter";
import { CheckCircle2, Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { SEO } from "@/components/seo";
import { PRICING_TIERS, FEATURE_MATRIX, PRICING_FAQ } from "@/lib/site-data";
import { cn } from "@/lib/utils";

function CellValue({ value }: { value: string }) {
  if (value === "yes") return <CheckCircle2 className="h-4 w-4 text-primary" />;
  if (value === "no") return <X className="h-4 w-4 text-muted-foreground/60" />;
  if (value === "—") return <Minus className="h-4 w-4 text-muted-foreground/60" />;
  return <span className="text-sm text-foreground">{value}</span>;
}

export default function PricingPage() {
  return (
    <>
      <SEO
        title="Pricing"
        description="Free for personal use, fair for creators, ready for the enterprise. Three tiers, no hidden token fees, never trained on your data."
      />
      <section className="border-b border-border/40 py-20 md:py-24">
        <div className="mx-auto max-w-7xl px-5 md:px-8">
          <Badge variant="outline" className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Pricing
          </Badge>
          <h1 className="mt-6 max-w-3xl text-balance text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            Free for people. Fair for creators. Ready for enterprise.
          </h1>
          <p className="mt-5 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground">
            We don't charge per token, we don't run inference servers, and we don't take
            a cut of what you make. Pricing is simple because the model is simple.
          </p>
        </div>
      </section>
      <section className="border-b border-border/40 py-20 md:py-24">
        <div className="mx-auto max-w-7xl px-5 md:px-8">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {PRICING_TIERS.map((tier) => (
              <Card
                key={tier.name}
                className={cn(
                  "relative flex flex-col overflow-hidden p-8",
                  tier.highlight && "border-primary/50",
                )}
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
                  className="mt-7 w-full"
                  variant={tier.highlight ? "default" : "outline"}
                >
                  {tier.ctaHref.startsWith("mailto:") ? (
                    <a href={tier.ctaHref}>{tier.cta}</a>
                  ) : (
                    <Link href={tier.ctaHref}>{tier.cta}</Link>
                  )}
                </Button>
                <ul className="mt-8 space-y-3">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-foreground">
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
      <section className="border-b border-border/40 py-20 md:py-24">
        <div className="mx-auto max-w-7xl px-5 md:px-8">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Compare every feature</h2>
          <p className="mt-3 max-w-2xl text-base text-muted-foreground">
            One table, no asterisks.
          </p>
          <div className="mt-10 overflow-hidden rounded-2xl border border-border">
            <table className="w-full">
              <thead className="bg-card/80">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="w-2/5 px-6 py-4 font-medium">Feature</th>
                  <th className="px-6 py-4 font-medium">Free</th>
                  <th className="px-6 py-4 font-medium text-primary">Creator</th>
                  <th className="px-6 py-4 font-medium">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {FEATURE_MATRIX.map((row, i) => (
                  <tr
                    key={row.feature}
                    className={cn(
                      "border-t border-border/60 text-sm",
                      i % 2 ? "bg-card/40" : "bg-card",
                    )}
                  >
                    <td className="px-6 py-4 font-medium text-foreground">{row.feature}</td>
                    <td className="px-6 py-4">
                      <CellValue value={row.free} />
                    </td>
                    <td className="px-6 py-4">
                      <CellValue value={row.creator} />
                    </td>
                    <td className="px-6 py-4">
                      <CellValue value={row.enterprise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section className="py-20 md:py-24">
        <div className="mx-auto max-w-3xl px-5 md:px-8">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Honest answers</h2>
          <p className="mt-3 text-base text-muted-foreground">
            The questions we get most often, answered the way we'd want them answered.
          </p>
          <Accordion type="single" collapsible className="mt-10 w-full">
            {PRICING_FAQ.map((item, i) => (
              <AccordionItem key={item.q} value={`item-${i}`} className="border-border/60">
                <AccordionTrigger className="text-left text-base text-foreground hover:no-underline">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>
    </>
  );
}
