// @effect-diagnostics globalDate:off
/**
 * Pure schedule math for scheduled checks: clamping, the next run time, and
 * the schedule in words. The server's scheduler and the web editor share it.
 *
 * Daily and weekly times are wall-clock times in an IANA time zone. Around
 * daylight saving changes:
 *
 * - a time that doesn't exist (the spring-forward gap) runs at the same
 *   offset as before the change, so 02:30 becomes 03:30;
 * - a time that happens twice (the fall-back overlap) runs at the first one.
 *
 * @module projectCheckSchedule
 */
import {
  PROJECT_CHECK_MAX_INTERVAL_MINUTES,
  PROJECT_CHECK_MIN_INTERVAL_MINUTES,
  type ProjectCheckSchedule,
} from "@t3tools/contracts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Raises intervals below 15 minutes and lowers ones above a week. */
export function normalizeCheckSchedule(schedule: ProjectCheckSchedule): ProjectCheckSchedule {
  if (schedule.kind !== "interval") return schedule;
  const everyMinutes = Math.min(
    PROJECT_CHECK_MAX_INTERVAL_MINUTES,
    Math.max(PROJECT_CHECK_MIN_INTERVAL_MINUTES, Math.round(schedule.everyMinutes)),
  );
  return everyMinutes === schedule.everyMinutes ? schedule : { kind: "interval", everyMinutes };
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    return Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** The wall clock in `timeZone` at instant `ms`, to the minute. */
function wallClockAt(ms: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
  };
}

/** The wall clock read as if it were UTC, in ms. */
function wallMs(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
}

/** Offset of `timeZone` from UTC at instant `ms` (wall minus UTC), in ms. */
function offsetAt(ms: number, timeZone: string): number {
  const flooredToMinute = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  return wallMs(wallClockAt(flooredToMinute, timeZone)) - flooredToMinute;
}

/** The instant a wall-clock time happens in `timeZone`, resolved as the module doc says. */
export function zonedWallTimeToEpochMs(clock: WallClock, timeZone: string): number {
  const target = wallMs(clock);
  // The offsets just before and after any change near this day.
  const before = offsetAt(target - DAY_MS, timeZone);
  const after = offsetAt(target + DAY_MS, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => target - offset)
    .filter((instant) => wallMs(wallClockAt(instant, timeZone)) === target)
    .sort((left, right) => left - right);
  return candidates[0] ?? target - before;
}

function parseTime(time: string): { readonly hour: number; readonly minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

/**
 * The first run strictly after `afterMs`. Interval schedules count from
 * `afterMs`; daily and weekly ones find the next matching wall-clock time.
 */
export function nextCheckRunAt(
  schedule: ProjectCheckSchedule,
  afterMs: number,
  timeZone: string,
): number {
  const normalized = normalizeCheckSchedule(schedule);
  if (normalized.kind === "interval") {
    return afterMs + normalized.everyMinutes * MINUTE_MS;
  }
  const { hour, minute } = parseTime(normalized.time);
  const today = wallClockAt(afterMs, timeZone);
  // Eight days covers every weekday plus a time earlier today.
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
    if (normalized.kind === "weekly" && date.getUTCDay() !== normalized.weekday) continue;
    const candidate = zonedWallTimeToEpochMs(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour,
        minute,
      },
      timeZone,
    );
    if (candidate > afterMs) return candidate;
  }
  // Unreachable for valid input; fall back to a day later rather than now.
  return afterMs + DAY_MS;
}

function plural(count: number, unit: string): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}

/** "Every 30 minutes", "Every 2 hours", "Daily at 09:00", "Weekly on Monday at 09:00". */
export function describeCheckSchedule(schedule: ProjectCheckSchedule): string {
  const normalized = normalizeCheckSchedule(schedule);
  switch (normalized.kind) {
    case "interval": {
      const minutes = normalized.everyMinutes;
      if (minutes % (24 * 60) === 0) return `Every ${plural(minutes / (24 * 60), "day")}`;
      if (minutes % 60 === 0) return `Every ${plural(minutes / 60, "hour")}`;
      return `Every ${plural(minutes, "minute")}`;
    }
    case "daily":
      return `Daily at ${normalized.time}`;
    case "weekly":
      return `Weekly on ${WEEKDAY_NAMES[normalized.weekday] ?? "Sunday"} at ${normalized.time}`;
  }
}
