/**
 * SkipLink — first focusable element on every page so keyboard and screen
 * reader users can jump past the navigation directly to the main content.
 *
 * The link is visually hidden until focused (WCAG 2.4.1). The target is the
 * `<main id="main-content">` rendered by `Layout` and `OperatorLayout`.
 */

import { useTranslation } from "react-i18next";

const TARGET_ID = "main-content";

export function SkipLink() {
  const { t } = useTranslation();
  return (
    <a
      href={`#${TARGET_ID}`}
      data-testid="skip-to-content"
      className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[100] focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {t("a11y.skipToContent")}
    </a>
  );
}

export const MAIN_CONTENT_ID = TARGET_ID;
