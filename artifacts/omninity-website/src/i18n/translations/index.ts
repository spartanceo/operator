/**
 * Lazy translation bundle registry.
 *
 * English ships with the main JS bundle so the first paint is never blocked.
 * Other locales are dynamic-imported on demand and registered with i18next
 * the first time the user (or the browser language detector) selects them.
 * This keeps the cold-start payload at one locale (~2 kB gzipped) instead
 * of all six (~12 kB) — a hard requirement of the bundle budget in
 * Standard 11.
 *
 * `loadLocale(code)` is idempotent: subsequent calls for the same locale
 * resolve immediately from the in-process map cache.
 */

import { en, type TranslationShape } from "./en";
import type { LocaleCode } from "../locales";

/**
 * Eager bundles loaded into the initial JS chunk.
 * Only English to minimise first-paint payload.
 */
export const RESOURCES: Partial<
  Record<LocaleCode, { translation: TranslationShape }>
> = {
  en: { translation: en },
};

// tier-review: bounded — fixed-size 6-locale loader registry, never mutated at runtime
const LAZY_LOADERS: Record<LocaleCode, () => Promise<TranslationShape>> = {
  en: async () => en,
  es: async () => (await import("./es")).es,
  fr: async () => (await import("./fr")).fr,
  de: async () => (await import("./de")).de,
  ja: async () => (await import("./ja")).ja,
  ar: async () => (await import("./ar")).ar,
};

const inflight = new Map<LocaleCode, Promise<TranslationShape>>();

export async function loadLocale(
  code: LocaleCode,
): Promise<TranslationShape> {
  const cached = RESOURCES[code]?.translation;
  if (cached) return cached;
  const existing = inflight.get(code);
  if (existing) return existing;
  const promise = LAZY_LOADERS[code]()
    .then((translation) => {
      RESOURCES[code] = { translation };
      return translation;
    })
    .finally(() => {
      inflight.delete(code);
    });
  inflight.set(code, promise);
  return promise;
}

/**
 * Synchronous accessor used by the parity-check CI script. It awaits every
 * loader once, populates `RESOURCES`, and returns the fully-loaded map.
 * The runtime never calls this — only `scripts/i18n-check.ts` does.
 */
export async function loadAllForCI(): Promise<
  Record<LocaleCode, { translation: TranslationShape }>
> {
  const codes = Object.keys(LAZY_LOADERS) as LocaleCode[];
  await Promise.all(codes.map((c) => loadLocale(c)));
  return RESOURCES as Record<LocaleCode, { translation: TranslationShape }>;
}
