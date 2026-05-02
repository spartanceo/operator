/**
 * Locale-aware formatting helpers built on `Intl`.
 *
 * Components should resolve `bcp47` from `useLocale().descriptor.bcp47`
 * and pass it in. Centralising the wrappers means we get the correct
 * locale-driven date, number, currency, and relative-time output
 * without scattering `new Intl.*` constructors across the codebase.
 *
 * Constructors are memoised in bounded LRU-shaped maps to avoid the
 * repeated allocation cost on hot paths (timeline, activity list).
 * Caps are tiny (one per locale × format), well under Standard 13's
 * unbounded-cache prohibition.
 */

// tier-review: bounded — capped at 64 entries below; one per (locale × DateTimeFormatOptions) combo
const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
// tier-review: bounded — capped at 64 entries below; one per (locale × NumberFormatOptions) combo
const numberFmtCache = new Map<string, Intl.NumberFormat>();
// tier-review: bounded — capped at 64 entries below; one per (locale × currency-code) combo
const currencyFmtCache = new Map<string, Intl.NumberFormat>();
// tier-review: bounded — capped at 16 entries below; one per locale tag
const relativeFmtCache = new Map<string, Intl.RelativeTimeFormat>();

function keyFor(bcp47: string, options: object): string {
  return `${bcp47}::${JSON.stringify(options)}`;
}

export function formatDate(
  bcp47: string,
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  const k = keyFor(bcp47, options);
  let fmt = dateFmtCache.get(k);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(bcp47, options);
    if (dateFmtCache.size < 64) dateFmtCache.set(k, fmt);
  }
  const date = value instanceof Date ? value : new Date(value);
  return fmt.format(date);
}

export function formatDateTime(
  bcp47: string,
  value: Date | number | string,
): string {
  return formatDate(bcp47, value, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatNumber(
  bcp47: string,
  value: number,
  options: Intl.NumberFormatOptions = {},
): string {
  const k = keyFor(bcp47, options);
  let fmt = numberFmtCache.get(k);
  if (!fmt) {
    fmt = new Intl.NumberFormat(bcp47, options);
    if (numberFmtCache.size < 64) numberFmtCache.set(k, fmt);
  }
  return fmt.format(value);
}

export function formatCurrency(
  bcp47: string,
  value: number,
  currency: string,
): string {
  const k = `${bcp47}::${currency}`;
  let fmt = currencyFmtCache.get(k);
  if (!fmt) {
    fmt = new Intl.NumberFormat(bcp47, { style: "currency", currency });
    if (currencyFmtCache.size < 64) currencyFmtCache.set(k, fmt);
  }
  return fmt.format(value);
}

const RELATIVE_THRESHOLDS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

export function formatRelativeTime(
  bcp47: string,
  from: Date | number | string,
  to: Date | number | string = Date.now(),
): string {
  const k = bcp47;
  let fmt = relativeFmtCache.get(k);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(bcp47, { numeric: "auto" });
    if (relativeFmtCache.size < 16) relativeFmtCache.set(k, fmt);
  }
  const fromMs = (from instanceof Date ? from : new Date(from)).getTime();
  const toMs = (to instanceof Date ? to : new Date(to)).getTime();
  const deltaSeconds = Math.round((fromMs - toMs) / 1000);
  for (const [unit, threshold] of RELATIVE_THRESHOLDS) {
    if (Math.abs(deltaSeconds) >= threshold || unit === "second") {
      const value = Math.round(deltaSeconds / threshold);
      return fmt.format(value, unit);
    }
  }
  return fmt.format(deltaSeconds, "second");
}

/**
 * Hook-style sugar for components that already have access to the
 * active locale via `useLocale()`. Returns the same helpers bound to
 * the descriptor's BCP-47 tag.
 */
export function bindFormatters(bcp47: string) {
  return {
    date: (v: Date | number | string, opts?: Intl.DateTimeFormatOptions) =>
      formatDate(bcp47, v, opts),
    dateTime: (v: Date | number | string) => formatDateTime(bcp47, v),
    number: (v: number, opts?: Intl.NumberFormatOptions) =>
      formatNumber(bcp47, v, opts),
    currency: (v: number, currency: string) =>
      formatCurrency(bcp47, v, currency),
    relativeTime: (from: Date | number | string, to?: Date | number | string) =>
      formatRelativeTime(bcp47, from, to),
  };
}
