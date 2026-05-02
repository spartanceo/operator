/**
 * i18next bootstrap for the Omninity Operator web artifact.
 *
 * Only the English bundle is preloaded — every other locale is added via
 * `addResourceBundle` after `loadLocale(code)` resolves. This keeps the
 * cold-start payload minimal while still presenting the chosen language
 * without a network round-trip on subsequent visits (i18next caches the
 * detected language under the `omninity.locale` localStorage key).
 *
 * Detection order:
 *   1. Persisted choice in localStorage under `omninity.locale`
 *   2. `navigator.language`
 *   3. `<html lang>` attribute
 *   4. Fallback to `DEFAULT_LOCALE`
 *
 * The active locale is reflected back onto `<html lang>` and `<html dir>`
 * by `LocaleProvider`, which also kicks off the lazy load when the user
 * picks a non-preloaded locale.
 */

import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE, SUPPORTED_LOCALE_CODES } from "./locales";
import { RESOURCES, loadLocale } from "./translations";
import type { LocaleCode } from "./locales";

export const LOCALE_STORAGE_KEY = "omninity.locale";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: RESOURCES,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALE_CODES],
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    partialBundledLanguages: true,
    interpolation: {
      // React already escapes everything; double-escaping breaks copy.
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      caches: ["localStorage"],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
    },
    react: {
      // Suspense conflicts with the wouter loading shells we already render.
      useSuspense: false,
    },
  });

/**
 * Ensure the requested locale is registered with i18next. Resolves once the
 * bundle is added — components calling `setLocale` must `await` this before
 * calling `i18n.changeLanguage` for the strings to actually render.
 */
export async function ensureLocaleRegistered(code: LocaleCode): Promise<void> {
  if (i18n.hasResourceBundle(code, "translation")) return;
  const translation = await loadLocale(code);
  i18n.addResourceBundle(code, "translation", translation, true, false);
}

// If the detector resolved a non-English language at boot, kick off its lazy
// load immediately so the first paint switches over as soon as the chunk
// arrives. Failures are intentionally swallowed — English remains usable.
const initial = i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LOCALE;
const initialBase = initial.split("-")[0] ?? DEFAULT_LOCALE;
if (
  SUPPORTED_LOCALE_CODES.includes(initialBase as LocaleCode) &&
  initialBase !== DEFAULT_LOCALE
) {
  void ensureLocaleRegistered(initialBase as LocaleCode).catch(() => {
    /* non-fatal — fallback locale renders. */
  });
}

export default i18n;
