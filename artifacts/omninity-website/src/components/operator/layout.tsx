import type { ReactNode } from "react";
import { OperatorSidebar } from "./sidebar";
import { OperatorHeader } from "./header";

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
      <OperatorSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <OperatorHeader
          title={title}
          {...(description !== undefined ? { description } : {})}
          {...(actions !== undefined ? { actions } : {})}
        />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
