/**
 * Tiny standard 5-field cron parser + next-fire calculator (Task #45).
 *
 * Supported syntax (Tier 1, deterministic — no external library):
 *   minute  hour  day-of-month  month  day-of-week
 *   - `*`              — every value
 *   - `5`              — exact value
 *   - `1,3,5`          — comma list
 *   - `1-5`            — inclusive range
 *   - `* / 15` (no spaces) — step over `*` (every 15 minutes)
 *   - `0-30/5`         — step over a range
 *
 * Day-of-week: 0 or 7 = Sunday … 6 = Saturday (matches POSIX cron).
 * Month: 1-12. Day-of-month: 1-31.
 *
 * `nextFireAfter(expr, fromMs)` returns the next fire timestamp at minute
 * resolution, or `null` if no fire is reachable in the next 366 days
 * (e.g. an impossible expression like `* * 31 2 *`). All times are UTC.
 *
 * Timezone is intentionally NOT modelled here — the schedules service
 * stores the user's preferred zone separately and converts before writing
 * cron expressions for now-aware kinds (e.g. "every Monday at 9am" gets
 * the user's local 9am converted to UTC at schedule-creation time). The
 * conversion is approximate (no DST awareness) and is acceptable for
 * Tier 1; a fuller TZ-aware engine is a downstream task.
 */

export class CronParseError extends Error {
  override readonly name = "CronParseError";
  readonly code = "CRON_INVALID";
  constructor(message: string) {
    super(message);
  }
}

interface ParsedCron {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  readonly domAny: boolean;
  readonly dowAny: boolean;
}

function parseField(field: string, min: number, max: number): {
  values: Set<number>;
  isStar: boolean;
} {
  const trimmed = field.trim();
  if (trimmed.length === 0) {
    throw new CronParseError("Empty cron field");
  }
  const out = new Set<number>();
  let isStar = trimmed === "*" || trimmed.startsWith("*/");
  for (const part of trimmed.split(",")) {
    let stepStr: string | undefined;
    let rangeStr = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      rangeStr = part.slice(0, slash);
      stepStr = part.slice(slash + 1);
    }
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) {
      throw new CronParseError(`Invalid step in "${part}"`);
    }
    let from: number;
    let to: number;
    if (rangeStr === "*" || rangeStr === "") {
      from = min;
      to = max;
    } else if (rangeStr.includes("-")) {
      const [a, b] = rangeStr.split("-");
      from = Number(a);
      to = Number(b);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
        throw new CronParseError(`Invalid range "${rangeStr}"`);
      }
    } else {
      from = Number(rangeStr);
      to = from;
      if (!Number.isInteger(from)) {
        throw new CronParseError(`Invalid value "${rangeStr}"`);
      }
    }
    if (from < min || to > max) {
      throw new CronParseError(
        `Value out of range in "${part}" (expected ${min}-${max})`,
      );
    }
    for (let v = from; v <= to; v += step) {
      out.add(v);
    }
  }
  if (out.size === 0) {
    throw new CronParseError(`Empty value set in "${field}"`);
  }
  return { values: out, isStar };
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `Expected 5 cron fields, got ${parts.length}: "${expr}"`,
    );
  }
  const minute = parseField(parts[0]!, 0, 59);
  const hour = parseField(parts[1]!, 0, 23);
  const dom = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12);
  const dowRaw = parseField(parts[4]!, 0, 7);
  // Normalise 7 -> 0 (Sunday).
  const dow = new Set<number>();
  for (const v of dowRaw.values) dow.add(v === 7 ? 0 : v);
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow,
    domAny: dom.isStar,
    dowAny: dowRaw.isStar,
  };
}

export function validateCron(expr: string): void {
  parseCron(expr);
}

/**
 * Compute the next fire timestamp strictly AFTER `fromMs` at minute
 * resolution (UTC). Returns `null` if no match is found within ~366 days.
 */
export function nextFireAfter(expr: string, fromMs: number): number | null {
  const cron = parseCron(expr);
  // Start at the next minute boundary after `fromMs`.
  const start = new Date(Math.floor(fromMs / 60_000) * 60_000 + 60_000);
  // Hard cap: 366 * 24 * 60 = 527040 minutes. We jump by day/hour where
  // possible so the inner loop stays well under that.
  const horizon = start.getTime() + 366 * 24 * 60 * 60 * 1000;
  const cur = new Date(start.getTime());
  while (cur.getTime() <= horizon) {
    const month = cur.getUTCMonth() + 1;
    if (!cron.month.has(month)) {
      // Jump to the 1st of the next month.
      cur.setUTCMonth(cur.getUTCMonth() + 1, 1);
      cur.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const dom = cur.getUTCDate();
    const dow = cur.getUTCDay();
    const dayMatches = matchesDay(cron, dom, dow);
    if (!dayMatches) {
      cur.setUTCDate(cur.getUTCDate() + 1);
      cur.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const hour = cur.getUTCHours();
    if (!cron.hour.has(hour)) {
      cur.setUTCHours(cur.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    const minute = cur.getUTCMinutes();
    if (!cron.minute.has(minute)) {
      cur.setUTCMinutes(cur.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return cur.getTime();
  }
  return null;
}

function matchesDay(cron: ParsedCron, dom: number, dow: number): boolean {
  // POSIX cron semantics: when BOTH dom and dow are restricted, the
  // matcher is the union (either matches → fire). When one is `*` we
  // simply require the other.
  const domHit = cron.dom.has(dom);
  const dowHit = cron.dow.has(dow);
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dowHit;
  if (cron.dowAny) return domHit;
  return domHit || dowHit;
}

/**
 * Convenience wrapper: returns the next N fires after `fromMs`.
 * Used by the UI to preview "the next 3 runs" when a user edits a
 * schedule.
 */
export function nextFires(
  expr: string,
  fromMs: number,
  count: number,
): number[] {
  const out: number[] = [];
  let cursor = fromMs;
  for (let i = 0; i < count; i += 1) {
    const next = nextFireAfter(expr, cursor);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
