/**
 * LanguageSwitcher — accessible select for the active UI locale.
 *
 * Uses a native `<select>` (not a Radix popover) so it is fully keyboard
 * accessible on every platform with no extra ARIA wiring, works inside a
 * focus trap without focus-restore bugs, and respects platform native
 * speech-engine integration on iOS / Android. The orange focus ring matches
 * the rest of the design system.
 */

import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useLocale } from "@/i18n/locale-context";
import { LOCALES, isLocaleCode } from "@/i18n/locales";
import { cn } from "@/lib/utils";

interface LanguageSwitcherProps {
  className?: string;
  /** Render only the icon and a tooltip-style label (compact navbar variant). */
  compact?: boolean;
}

export function LanguageSwitcher({
  className,
  compact = false,
}: LanguageSwitcherProps) {
  const { t } = useTranslation();
  const { locale, descriptor, setLocale } = useLocale();

  const labelId = "language-switcher-label";

  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <Languages className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <label
        id={labelId}
        htmlFor="language-switcher"
        className={cn(compact ? "sr-only" : "text-sm text-muted-foreground")}
      >
        {t("a11y.languageSelector")}
      </label>
      <select
        id="language-switcher"
        data-testid="language-switcher"
        value={locale}
        onChange={(event) => {
          const next = event.target.value;
          if (isLocaleCode(next)) setLocale(next);
        }}
        aria-labelledby={labelId}
        aria-label={t("a11y.openLanguageMenu")}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {LOCALES.map((option) => (
          <option key={option.code} value={option.code}>
            {option.nativeName}
            {option.code !== descriptor.code ? ` (${option.englishName})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
