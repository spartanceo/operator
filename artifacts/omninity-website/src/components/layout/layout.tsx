import type { ReactNode } from "react";
import { Nav } from "@/components/layout/nav";
import { Footer } from "@/components/layout/footer";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground antialiased">
      <Nav />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
