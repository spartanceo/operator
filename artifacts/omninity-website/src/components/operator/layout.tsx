import type { ReactNode } from "react";
import { OperatorSidebar } from "./sidebar";
import { OperatorHeader } from "./header";
import { DiskHealthBanner } from "./disk-health-banner";
import { UpdateBanner } from "@/components/onboarding/update-banner";
import { SkipLink, MAIN_CONTENT_ID } from "@/components/a11y/skip-link";

interface OperatorLayoutProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function OperatorLayout({
  title,
  description,
  actions,
  children,
}: OperatorLayoutProps) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <SkipLink />
      <OperatorSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <UpdateBanner />
        <DiskHealthBanner />
        <OperatorHeader
          title={title}
          {...(description !== undefined ? { description } : {})}
          {...(actions !== undefined ? { actions } : {})}
        />
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
