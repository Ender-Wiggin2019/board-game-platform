import { contractError } from '@board-game/contracts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function localParts(value: Date, timezone: string): readonly number[] {
  if (!Number.isFinite(value.getTime()))
    throw contractError('INVALID_REQUEST', 'platform.daily.date');
  try {
    const parts = new Map(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(value)
        .map((part) => [part.type, part.value]),
    );
    return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) =>
      Number(parts.get(key as Intl.DateTimeFormatPartTypes)),
    );
  } catch {
    throw contractError('CONFLICT', 'platform.daily.timezone');
  }
}

function wallClock(value: Date, timezone: string): number {
  const [year, month, day, hour, minute, second] = localParts(value, timezone);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function calendarDate(value: Date, timezone: string): string {
  const [year, month, day] = localParts(value, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Resolve wall time using offsets on both sides of a possible DST transition. */
function atLocalTime(
  date: string,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const target = Date.parse(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`,
  );
  if (!Number.isFinite(target))
    throw contractError('INVALID_REQUEST', 'platform.daily.date');
  const offsets = new Set(
    [-36, 0, 36].map((hours) => {
      const instant = target + hours * 60 * MINUTE_MS;
      return wallClock(new Date(instant), timezone) - instant;
    }),
  );
  const candidates = [...offsets].map((offset) => new Date(target - offset));
  // A repeated wall time uses its first occurrence. If the clock skips the
  // requested time, move forward by the gap, matching local Date semantics.
  const exact = candidates
    .filter((value) => wallClock(value, timezone) === target)
    .sort((left, right) => left.getTime() - right.getTime());
  if (exact[0]) return exact[0];
  const after = candidates
    .filter((value) => wallClock(value, timezone) > target)
    .sort((left, right) => left.getTime() - right.getTime());
  if (after[0]) return after[0];
  throw contractError('CONFLICT', 'platform.daily.timezone');
}

/** SETI's established daily window, interpreted in the release's explicit zone. */
export function dailyChallengeWindow(now: Date, timezone = 'UTC') {
  const date = calendarDate(now, timezone);
  const refreshAt = atLocalTime(date, 23, 59, timezone);
  const challengeDate = now >= refreshAt ? nextDate(date) : date;
  return {
    challengeDate,
    nextRefreshAt:
      now < refreshAt
        ? refreshAt
        : atLocalTime(nextDate(date), 23, 59, timezone),
    eligibilityCutoffAt: dailyChallengeCutoffAt(challengeDate, timezone),
  };
}

export function dailyChallengeCutoffAt(date: string, timezone = 'UTC'): Date {
  return atLocalTime(nextDate(date), 3, 0, timezone);
}
