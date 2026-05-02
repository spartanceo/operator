import { AlertTriangle } from "lucide-react";
import { ApiError } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

interface ErrorBannerProps {
  error: unknown;
  className?: string;
  title?: string;
}

function describe(error: unknown): { code?: string; message: string } {
  if (error instanceof ApiError) {
    const data = error.data as { error?: { code?: string; message?: string } } | null;
    const code = data?.error?.code;
    const message = data?.error?.message ?? error.message;
    return code ? { code, message } : { message };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: "Something went wrong." };
}

export function ErrorBanner({ error, className, title }: ErrorBannerProps) {
  if (!error) return null;
  const { code, message } = describe(error);
  return (
    <div
      role="alert"
      data-testid="error-banner"
      className={cn(
        "flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm",
        className,
      )}
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-destructive">
          {title ?? "Request failed"}
          {code ? <span className="ml-1 font-mono text-xs">[{code}]</span> : null}
        </p>
        <p className="mt-0.5 break-words text-foreground/80">{message}</p>
      </div>
    </div>
  );
}
