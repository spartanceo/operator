import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Risk = "low" | "medium" | "high" | "critical";

const STYLES: Record<Risk, string> = {
  low: "text-emerald-600 dark:text-emerald-400",
  medium: "text-amber-600 dark:text-amber-400",
  high: "text-orange-600 dark:text-orange-400",
  critical: "text-destructive",
};

export function RiskBadge({
  risk,
  className,
}: {
  risk: string;
  className?: string;
}) {
  const normalized = (risk?.toLowerCase() as Risk) ?? "low";
  const style = STYLES[normalized] ?? STYLES.low;
  return (
    <Badge
      variant="outline"
      className={cn("uppercase tracking-wide", style, className)}
      data-testid={`badge-risk-${normalized}`}
    >
      {normalized}
    </Badge>
  );
}
