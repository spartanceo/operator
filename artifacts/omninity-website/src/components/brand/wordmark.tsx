import { cn } from "@/lib/utils";

interface WordmarkProps {
  className?: string;
  monochrome?: boolean;
  size?: "sm" | "md" | "lg";
}

const SIZES: Record<NonNullable<WordmarkProps["size"]>, { svg: string; text: string }> = {
  sm: { svg: "h-5 w-5", text: "text-sm" },
  md: { svg: "h-6 w-6", text: "text-[15px]" },
  lg: { svg: "h-8 w-8", text: "text-lg" },
};

export function Wordmark({ className, monochrome, size = "md" }: WordmarkProps) {
  const accentClass = monochrome ? "text-foreground" : "text-primary";
  const dim = SIZES[size];
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className={cn("relative inline-block", dim.svg)} aria-hidden="true">
        <svg viewBox="0 0 32 32" className="absolute inset-0 h-full w-full" fill="none">
          <rect
            x="1.5"
            y="1.5"
            width="29"
            height="29"
            rx="6"
            className="stroke-border"
            strokeWidth="1.5"
          />
          <circle cx="16" cy="16" r="7" className={cn("stroke-current", accentClass)} strokeWidth="1.75" />
          <circle cx="16" cy="16" r="2.25" className={cn("fill-current", accentClass)} />
          <line
            x1="16"
            y1="2.5"
            x2="16"
            y2="6.5"
            className={cn("stroke-current", accentClass)}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="16"
            y1="25.5"
            x2="16"
            y2="29.5"
            className={cn("stroke-current", accentClass)}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className={cn("font-semibold tracking-tight text-foreground", dim.text)}>
        Omninity<span className={cn("ml-1 font-medium", accentClass)}>OP</span>
      </span>
    </span>
  );
}

export function WordmarkLockup({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Wordmark size="lg" />
      <span className="text-xs text-muted-foreground">
        The private operating layer for your computer.
      </span>
    </div>
  );
}
