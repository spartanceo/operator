import { cn } from "@/lib/utils";

interface JsonViewProps {
  value: unknown;
  className?: string;
  emptyLabel?: string;
}

export function JsonView({ value, className, emptyLabel }: JsonViewProps) {
  const isEmpty =
    value === null ||
    value === undefined ||
    (typeof value === "object" &&
      value !== null &&
      Object.keys(value as Record<string, unknown>).length === 0);

  if (isEmpty && emptyLabel) {
    return (
      <p className={cn("text-xs italic text-muted-foreground", className)}>
        {emptyLabel}
      </p>
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }

  return (
    <pre
      className={cn(
        "overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground",
        className,
      )}
    >
      {serialized}
    </pre>
  );
}
