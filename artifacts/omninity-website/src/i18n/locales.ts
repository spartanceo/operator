/**
 * Locale registry for Omninity Operator.
 *
 * Locked at v1 to the six launch languages from Task #28. Adding a new locale
 * means adding it here AND shipping a translation bundle under
 * `src/i18n/translations/<code>.ts`. The CI missing-key detector
 * (`scripts/i18n-check.ts`) walks this list.
 */

export type LocaleCode = "en" | "es" | "fr" | "de" | "ja" | "ar";

export interface LocaleDescriptor {
  code: LocaleCode;
  /** Native name (shown in the language switcher). */
  nativeName: string;
  /** English name (shown next to native name). */
  englishName: string;
  /** Whether this locale renders right-to-left. */
  rtl: boolean;
  /** BCP-47 tag used for `Intl.*` formatting. */
  bcp47: string;
}

// tier-review: bounded — fixed-size 6-locale registry, never mutated at runtime
export const LOCALES: ReadonlyArray<LocaleDescriptor> = [
  { code: "en", nativeName: "English", englishName: "English", rtl: false, bcp47: "en-US" },
  { code: "es", nativeName: "Español", englishName: "Spanish", rtl: false, bcp47: "es-ES" },
  { code: "fr", nativeName: "Français", englishName: "French", rtl: false, bcp47: "fr-FR" },
  { code: "de", nativeName: "Deutsch", englishName: "German", rtl: false, bcp47: "de-DE" },
  { code: "ja", nativeName: "日本語", englishName: "Japanese", rtl: false, bcp47: "ja-JP" },
  { code: "ar", nativeName: "العربية", englishName: "Arabic", rtl: true, bcp47: "ar-SA" },
] as const;

export const DEFAULT_LOCALE: LocaleCode = "en";

export const SUPPORTED_LOCALE_CODES: ReadonlyArray<LocaleCode> = LOCALES.map(
  (l) => l.code,
);

export function getLocaleDescriptor(code: string): LocaleDescriptor {
  const found = LOCALES.find((l) => l.code === code);
  return found ?? LOCALES[0]!;
}

export function isLocaleCode(value: unknown): value is LocaleCode {
  return (
    typeof value === "string" &&
    SUPPORTED_LOCALE_CODES.includes(value as LocaleCode)
  );
}
