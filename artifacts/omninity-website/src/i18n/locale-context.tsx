/**
 * LocaleProvider — single owner of the current i18next language plus the
 * `<html lang>` / `<html dir>` reflection that drives RTL layouts.
 *
 * Components consume the active locale through `useLocale()`, change it
 * through `setLocale()`, and translate strings through the standard
 * `useTranslation()` hook from react-i18next.
 *
 * Persistence is delegated to i18next's localStorage detector — we just
 * make sure the document attributes follow the active language.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { I18nextProvider, useTranslation } from "react-i18next";

import i18n, { LOCALE_STORAGE_KEY, ensureLocaleRegistered } from "./index";
import {
  DEFAULT_LOCALE,
  getLocaleDescriptor,
  isLocaleCode,
  type LocaleCode,
  type LocaleDescriptor,
} from "./locales";

interface LocaleContextValue {
  locale: LocaleCode;
  descriptor: LocaleDescriptor;
  setLocale: (next: LocaleCode) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readInitialLocale(): LocaleCode {
  const detected = i18n.resolvedLanguage ?? i18n.language;
  if (isLocaleCode(detected)) return detected;
  // i18next may pick a region-specific tag like `en-GB`; fall back to the base.
  const base = typeof detected === "string" ? detected.split("-")[0] : "";
  if (isLocaleCode(base)) return base;
  return DEFAULT_LOCALE;
}

function applyDocumentLocale(descriptor: LocaleDescriptor): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.lang = descriptor.code;
  root.dir = descriptor.rtl ? "rtl" : "ltr";
  root.dataset["locale"] = descriptor.code;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(readInitialLocale);

  // Reflect the current locale to the document on mount and on change.
  useEffect(() => {
    const descriptor = getLocaleDescriptor(locale);
    applyDocumentLocale(descriptor);
  }, [locale]);

  const setLocale = useCallback((next: LocaleCode) => {
    // Fire-and-forget: register the bundle (lazy import) then switch i18next.
    void ensureLocaleRegistered(next)
      .catch(() => {
        /* non-fatal — i18next will fall back to English for missing keys. */
      })
      .finally(() => {
        void i18n.changeLanguage(next);
      });
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // localStorage may be blocked (e.g. private browsing) — non-fatal.
    }
    setLocaleState(next);
  }, []);

  // Track i18next-driven changes (e.g. external `i18n.changeLanguage`).
  useEffect(() => {
    const handler = (next: string) => {
      const base = next.split("-")[0] ?? next;
      if (isLocaleCode(base)) setLocaleState(base);
    };
    i18n.on("languageChanged", handler);
    return () => {
      i18n.off("languageChanged", handler);
    };
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      descriptor: getLocaleDescriptor(locale),
      setLocale,
    }),
    [locale, setLocale],
  );

  return (
    <I18nextProvider i18n={i18n}>
      <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
    </I18nextProvider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocale must be used inside a <LocaleProvider>.");
  }
  return ctx;
}

// Re-export the standard hook so feature components only import from one place.
export { useTranslation };
