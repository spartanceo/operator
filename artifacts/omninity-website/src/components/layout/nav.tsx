import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Menu, ArrowDownToLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Wordmark } from "@/components/brand/wordmark";
import { cn } from "@/lib/utils";

const NAV_ITEMS: { label: string; href: string }[] = [
  { label: "Product", href: "/" },
  { label: "Marketplace", href: "/marketplace" },
  { label: "Pricing", href: "/pricing" },
  { label: "Creators", href: "/creators" },
  { label: "Docs", href: "/docs" },
];

export function Nav() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) =>
    href === "/" ? location === "/" : location === href || location.startsWith(href + "/");

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 md:px-8">
        <div className="flex items-center gap-10">
          <Link href="/" className="hover-elevate -mx-2 rounded-md px-2 py-1.5">
            <Wordmark />
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "hover-elevate rounded-md px-3 py-1.5 text-sm transition-colors",
                  isActive(item.href)
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="hidden items-center gap-3 md:flex">
          <Button size="sm" asChild className="gap-2">
            <Link href="/download">
              <ArrowDownToLine className="h-4 w-4" />
              Download OP
            </Link>
          </Button>
        </div>
        <div className="md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Open menu">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 bg-background">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="mt-2 flex flex-col gap-1">
                <Wordmark className="mb-6 px-1" />
                {NAV_ITEMS.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "hover-elevate rounded-md px-3 py-2 text-sm",
                      isActive(item.href) ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                ))}
                <Button asChild className="mt-4 w-full gap-2">
                  <Link href="/download" onClick={() => setOpen(false)}>
                    <ArrowDownToLine className="h-4 w-4" />
                    Download OP
                  </Link>
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
