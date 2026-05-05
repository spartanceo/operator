import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Menu, ArrowDownToLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Wordmark } from "@/components/brand/wordmark";
import { LanguageSwitcher } from "@/components/a11y/language-switcher";
import { cn } from "@/lib/utils";

interface NavItem {
  /** Translation key under `nav` namespace. */
  labelKey: "product" | "marketplace" | "pricing" | "creators" | "docs";
  href: string;
}

// tier-review: bounded — fixed-size 5-item nav, never mutated at runtime
const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { labelKey: "product", href: "/" },
  { labelKey: "marketplace", href: "/marketplace" },
  { labelKey: "pricing", href: "/pricing" },
  { labelKey: "creators", href: "/creators" },
  { labelKey: "docs", href: "/docs" },
];

export function Nav() {
  const { t } = useTranslation();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) =>
    href === "/" ? location === "/" : location === href || location.startsWith(href + "/");

  return (
    <header
      className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur-md"
      role="banner"
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 md:px-8">
        <div className="flex items-center gap-10">
          <Link
            href="/"
            className="hover-elevate -mx-2 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label={t("common.appName")}
          >
            <Wordmark />
          </Link>
          <nav
            className="hidden items-center gap-1 md:flex"
            aria-label={t("nav.navigation")}
          >
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "hover-elevate rounded-md px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`nav.${item.labelKey}`)}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="hidden items-center gap-3 md:flex">
          <LanguageSwitcher compact />
          <Button size="sm" variant="ghost" asChild>
            <Link href="/login">Sign In</Link>
          </Button>
          <Button size="sm" asChild className="gap-2">
            <Link href="/download">
              <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
              {t("common.download")}
            </Link>
          </Button>
        </div>
        <div className="md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" aria-label={t("nav.openMenu")}>
                <Menu className="h-4 w-4" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 bg-background">
              <SheetTitle className="sr-only">{t("nav.navigation")}</SheetTitle>
              <div className="mt-2 flex flex-col gap-1">
                <Wordmark className="mb-6 px-1" />
                {NAV_ITEMS.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "hover-elevate rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring",
                        active ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {t(`nav.${item.labelKey}`)}
                    </Link>
                  );
                })}
                <div className="mt-4 px-1">
                  <LanguageSwitcher />
                </div>
                <Button variant="outline" asChild className="mt-4 w-full">
                  <Link href="/login" onClick={() => setOpen(false)}>
                    Sign In
                  </Link>
                </Button>
                <Button asChild className="mt-2 w-full gap-2">
                  <Link href="/download" onClick={() => setOpen(false)}>
                    <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
                    {t("common.download")}
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
