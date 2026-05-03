/**
 * Natural-language → cron parser (Task #45).
 *
 * The task description hints at using the local LLM for this; Tier 1
 * deterministic stubs (matching the agent service convention) ship a
 * pure-function pattern matcher that handles the most common phrasings.
 * When Ollama is reachable a future iteration will fall back to the
 * model for unrecognised inputs.
 *
 * Recognised forms (case-insensitive):
 *   - "every minute"
 *   - "every N minutes"
 *   - "hourly" / "every hour" / "every N hours"
 *   - "daily at 6pm" / "every day at 18:00"
 *   - "every weekday at 9am"
 *   - "every weekend at 10am"
 *   - "every Monday at 9am"
 *   - "every Mon, Wed, Fri at 8:30"
 *   - "weekly on Friday at 5pm"
 *   - "monthly on the 1st at 9am"
 *   - "on the 15th at noon"
 *
 * Returns the cron expression and the inferred "recurrence kind"
 * (`once`, `minutely`, `hourly`, `daily`, `weekly`, `monthly`, `custom`).
 *
 * Times are parsed as the user's local time and converted to a UTC cron
 * expression using the supplied offset (minutes east of UTC). The
 * conversion is non-DST-aware on purpose — the scheduler engine
 * recomputes `next_run_at` from cron at every fire so a one-hour DST
 * drift self-corrects within a day.
 */

export class ScheduleParseError extends Error {
  override readonly name = "ScheduleParseError";
  readonly code = "SCHEDULE_PARSE_FAILED";
  constructor(message: string) {
    super(message);
  }
}

export type RecurrenceKind =
  | "minutely"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "custom";

export interface ParsedSchedule {
  cronExpression: string;
  recurrenceKind: RecurrenceKind;
}

// tier-review: bounded — fixed weekday-name lookup table, never mutated at runtime
const DAY_NAMES: ReadonlyMap<string, number> = new Map([
  ["sun", 0], ["sunday", 0],
  ["mon", 1], ["monday", 1],
  ["tue", 2], ["tues", 2], ["tuesday", 2],
  ["wed", 3], ["weds", 3], ["wednesday", 3],
  ["thu", 4], ["thur", 4], ["thurs", 4], ["thursday", 4],
  ["fri", 5], ["friday", 5],
  ["sat", 6], ["saturday", 6],
]);

interface ParsedTime {
  hour: number;
  minute: number;
}

function parseTime(input: string): ParsedTime | null {
  const s = input.trim().toLowerCase();
  if (s === "noon") return { hour: 12, minute: 0 };
  if (s === "midnight") return { hour: 0, minute: 0 };
  // 9, 9am, 9:30, 9:30am, 18:00, 18
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (meridiem === "am") {
    if (hour === 12) hour = 0;
    else if (hour > 12) return null;
  } else if (meridiem === "pm") {
    if (hour < 12) hour += 12;
    if (hour > 23) return null;
  }
  if (hour < 0 || hour > 23) return null;
  return { hour, minute };
}

/**
 * Convert a local hour/minute to UTC by subtracting the supplied offset.
 * `tzOffsetMinutes` is "minutes east of UTC" (e.g. New York standard
 * time is -300). `hour` may wrap into the previous/next day; we return
 * the wrapped hour 0-23 and a `dayShift` of -1, 0, or +1 so callers can
 * roll a day-of-week list when the wrap crosses midnight.
 */
function localToUtc(
  hour: number,
  minute: number,
  tzOffsetMinutes: number,
): { hour: number; minute: number; dayShift: -1 | 0 | 1 } {
  const totalMinutes = hour * 60 + minute - tzOffsetMinutes;
  const minutesPerDay = 24 * 60;
  let normalised = totalMinutes;
  let dayShift: -1 | 0 | 1 = 0;
  if (normalised < 0) {
    normalised += minutesPerDay;
    dayShift = -1;
  } else if (normalised >= minutesPerDay) {
    normalised -= minutesPerDay;
    dayShift = 1;
  }
  return {
    hour: Math.floor(normalised / 60),
    minute: normalised % 60,
    dayShift,
  };
}

function shiftDays(days: number[], shift: -1 | 0 | 1): number[] {
  if (shift === 0) return days;
  return days.map((d) => (d + shift + 7) % 7);
}

function pickDays(text: string): number[] {
  const out = new Set<number>();
  const tokens = text.toLowerCase().split(/[,\s]+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok === "weekday" || tok === "weekdays") {
      [1, 2, 3, 4, 5].forEach((d) => out.add(d));
      continue;
    }
    if (tok === "weekend" || tok === "weekends") {
      [0, 6].forEach((d) => out.add(d));
      continue;
    }
    const idx = DAY_NAMES.get(tok);
    if (idx !== undefined) out.add(idx);
  }
  return [...out].sort((a, b) => a - b);
}

// tier-review: bounded — fixed ordinal-name lookup table, never mutated at runtime
const ORDINAL: ReadonlyMap<string, number> = new Map([
  ["first", 1], ["1st", 1],
  ["second", 2], ["2nd", 2],
  ["third", 3], ["3rd", 3],
  ["fourth", 4], ["4th", 4],
  ["fifth", 5], ["5th", 5],
  ["last", 28],
]);

/**
 * Parse a natural-language schedule.
 *
 * `tzOffsetMinutes` is "minutes east of UTC" matching
 * `-new Date().getTimezoneOffset()` semantics on the browser.
 */
export function parseNaturalLanguageSchedule(
  rawInput: string,
  tzOffsetMinutes = 0,
): ParsedSchedule {
  const input = rawInput.trim().toLowerCase();
  if (input.length === 0) {
    throw new ScheduleParseError("Schedule description is empty");
  }

  // every N minutes
  const everyN = input.match(/^every\s+(\d+)\s+minutes?$/);
  if (everyN) {
    const n = Number(everyN[1]);
    if (n < 1 || n > 59) {
      throw new ScheduleParseError(
        `"every ${n} minutes" — N must be between 1 and 59`,
      );
    }
    return {
      cronExpression: `*/${n} * * * *`,
      recurrenceKind: "minutely",
    };
  }
  if (input === "every minute") {
    return { cronExpression: "* * * * *", recurrenceKind: "minutely" };
  }

  // hourly / every hour / every N hours
  if (input === "hourly" || input === "every hour") {
    return { cronExpression: "0 * * * *", recurrenceKind: "hourly" };
  }
  const everyNH = input.match(/^every\s+(\d+)\s+hours?$/);
  if (everyNH) {
    const n = Number(everyNH[1]);
    if (n < 1 || n > 23) {
      throw new ScheduleParseError(
        `"every ${n} hours" — N must be between 1 and 23`,
      );
    }
    return {
      cronExpression: `0 */${n} * * *`,
      recurrenceKind: "hourly",
    };
  }

  // monthly on the Nth at TIME
  const monthly = input.match(
    /^(?:monthly\s+)?on\s+the\s+(\w+)(?:\s+at\s+(.+))?$/,
  );
  if (monthly) {
    const ord = ORDINAL.get(monthly[1]!) ?? Number(monthly[1]);
    if (!Number.isInteger(ord) || ord < 1 || ord > 31) {
      throw new ScheduleParseError(`Unknown day-of-month "${monthly[1]}"`);
    }
    const time = monthly[2] ? parseTime(monthly[2]) : { hour: 9, minute: 0 };
    if (!time) {
      throw new ScheduleParseError(`Cannot parse time "${monthly[2]}"`);
    }
    const utc = localToUtc(time.hour, time.minute, tzOffsetMinutes);
    return {
      cronExpression: `${utc.minute} ${utc.hour} ${ord} * *`,
      recurrenceKind: "monthly",
    };
  }
  const monthlyAlt = input.match(
    /^monthly\s+at\s+(.+)$/,
  );
  if (monthlyAlt) {
    const time = parseTime(monthlyAlt[1]!);
    if (!time) throw new ScheduleParseError(`Cannot parse time "${monthlyAlt[1]}"`);
    const utc = localToUtc(time.hour, time.minute, tzOffsetMinutes);
    return {
      cronExpression: `${utc.minute} ${utc.hour} 1 * *`,
      recurrenceKind: "monthly",
    };
  }

  // weekly on DAYS at TIME (also: "every Monday at 9am", "every Mon,Wed at 8")
  const weekdayAt = input.match(
    /^(?:every|weekly\s+on)\s+(.+?)\s+at\s+(.+)$/,
  );
  if (weekdayAt) {
    const days = pickDays(weekdayAt[1]!);
    if (days.length > 0) {
      const time = parseTime(weekdayAt[2]!);
      if (!time) throw new ScheduleParseError(`Cannot parse time "${weekdayAt[2]}"`);
      const utc = localToUtc(time.hour, time.minute, tzOffsetMinutes);
      const shifted = shiftDays(days, utc.dayShift);
      return {
        cronExpression: `${utc.minute} ${utc.hour} * * ${shifted.join(",")}`,
        recurrenceKind: "weekly",
      };
    }
    // Fall through to "every day at TIME" handling below.
  }

  // daily at TIME / every day at TIME
  const dailyAt = input.match(
    /^(?:daily|every\s+day)\s+at\s+(.+)$/,
  );
  if (dailyAt) {
    const time = parseTime(dailyAt[1]!);
    if (!time) throw new ScheduleParseError(`Cannot parse time "${dailyAt[1]}"`);
    const utc = localToUtc(time.hour, time.minute, tzOffsetMinutes);
    return {
      cronExpression: `${utc.minute} ${utc.hour} * * *`,
      recurrenceKind: "daily",
    };
  }
  if (input === "daily" || input === "every day") {
    const utc = localToUtc(9, 0, tzOffsetMinutes);
    return {
      cronExpression: `${utc.minute} ${utc.hour} * * *`,
      recurrenceKind: "daily",
    };
  }

  // bare cron — pass through if it parses.
  if (/^[\d*\/,\-\s]+$/.test(input) && input.split(/\s+/).length === 5) {
    return { cronExpression: input, recurrenceKind: "custom" };
  }

  throw new ScheduleParseError(
    `Could not understand schedule "${rawInput}". Try "every Monday at 9am", "daily at 6pm", "every 2 hours", or a 5-field cron expression.`,
  );
}
