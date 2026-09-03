import type { Variable } from "./model";
import { attributeText } from "./model.ts";

export interface TimeDescription {
  multiplierMs: number;
  originMs: number;
  zoneLabel: string;
  offsetMinutes: number;
}

export interface TimeTickLabel {
  primary: string;
  secondary?: string;
  day?: boolean;
}

export interface DisplayTimeZone {
  readonly label: string;
  readonly offsetMinutes: number;
}

export const UTC_TIME_ZONE: DisplayTimeZone = Object.freeze({
  label: "UTC",
  offsetMinutes: 0,
});

const UTC_CALENDARS = new Set(["standard", "gregorian", "proleptic_gregorian"]);

export function timeInZone(
  time: TimeDescription | undefined,
  zone: DisplayTimeZone,
): TimeDescription | undefined {
  if (!time) return undefined;
  return {
    ...time,
    offsetMinutes: zone.offsetMinutes,
    zoneLabel: zone.label,
  };
}

export function parseDisplayTimeZone(value: string | null): DisplayTimeZone | undefined {
  const match = /^([A-Za-z][A-Za-z0-9._+-]{0,15}),([+-]?\d{1,4})$/.exec(value ?? "");
  if (!match) return undefined;
  const offsetMinutes = Number(match[2]);
  if (Math.abs(offsetMinutes) > 840 || (match[1] === "UTC" && offsetMinutes !== 0)) {
    return undefined;
  }
  return offsetMinutes === 0 && match[1] === "UTC"
    ? UTC_TIME_ZONE
    : { label: match[1], offsetMinutes };
}

export function describeTime(variable: Variable | undefined): TimeDescription | undefined {
  if (!variable) return undefined;
  const calendar = (attributeText(variable, "calendar") ?? "standard").trim().toLowerCase();
  // Non-Gregorian model calendars do not identify real UTC instants. Treating
  // them as JavaScript dates would silently align unrelated field frames.
  if (!UTC_CALENDARS.has(calendar)) return undefined;
  const units = attributeText(variable, "units");
  if (!units) return undefined;
  const match = /^(seconds?|minutes?|hours?|days?) since (.+)$/i.exec(units.trim());
  if (!match) return undefined;
  const multipliers: Record<string, number> = {
    second: 1000,
    seconds: 1000,
    minute: 60_000,
    minutes: 60_000,
    hour: 3_600_000,
    hours: 3_600_000,
    day: 86_400_000,
    days: 86_400_000,
  };
  const originText = match[2].trim();
  const offsetMatch = /([+-])(\d{2}):?(\d{2})$/.exec(originText);
  const offsetMinutes = offsetMatch
    ? (offsetMatch[1] === "+" ? 1 : -1) *
      (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]))
    : 0;
  const explicitUtc = originText.replace(/\s+(UTC|GMT)$/i, "Z");
  const normalized = (explicitUtc.includes("T")
    ? explicitUtc
    : explicitUtc.replace(" ", "T"))
    .replace(/\s+([+-]\d{2}:?\d{2}|Z)$/i, "$1");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const originMs = Date.parse(withZone);
  if (!Number.isFinite(originMs)) return undefined;
  return {
    multiplierMs: multipliers[match[1].toLowerCase()],
    originMs,
    offsetMinutes,
    zoneLabel: offsetMinutes === 0 ? "UTC" : `UTC${formatOffset(offsetMinutes)}`,
  };
}

/** One tick on a curve plot's time axis. */
export interface TimeTick {
  /** Position, in the time variable's own units. */
  value: number;
  /** A day boundary. Majors carry the date and a longer tick mark. */
  major: boolean;
  /** Hour on a minor tick, day of month on a major one. */
  primary: string;
  /** Month name, set on the first major and again whenever the month turns. */
  month?: string;
}

/** Clock-aligned steps, in ms. A time axis lands on readable instants or it is
 *  not a time axis, so this is a fixed ladder rather than a 1/2/5 rounding. */
const STEPS_MS = [
  3_600_000,
  3 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  86_400_000,
  2 * 86_400_000,
  5 * 86_400_000,
  10 * 86_400_000,
];

/**
 * Ticks for a curve plot's time axis.
 *
 * The two-row date follows Style (`plotstyle/rc.py` sets `%d %b` for a day and
 * stacks the clock under it), with the rows split so the axis reads as a scale
 * rather than a list of stamps: midnight is a major tick carrying `20` over
 * `Sep`, the hours between it are minor ticks carrying `03` to `21`, and the
 * month is named once and then only when it turns. Midnight never prints `00`
 * -- the date is what that tick means. The zone is stated once in the axis
 * note, so no label repeats a `Z`.
 *
 * `minimumStep` is the smallest tick spacing the panel has room for, in the
 * axis's own units; the ladder takes the first step at or above it, which is
 * DCL's rule (`usurdt.f`) with a clock ladder in place of 1/2/5.
 */
export function timeAxisTicks(
  minimum: number,
  maximum: number,
  time: TimeDescription,
  minimumStep: number,
): TimeTick[] {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low === high) return [];
  const wantedMs = Math.abs(minimumStep * time.multiplierMs);
  const stepMs =
    STEPS_MS.find((candidate) => candidate >= wantedMs) ?? STEPS_MS[STEPS_MS.length - 1];
  // Aligning in shifted milliseconds is what puts ticks on the *displayed*
  // clock: a +08:00 axis breaks its days at that zone's midnight, not UTC's.
  const shift = time.originMs + time.offsetMinutes * 60_000;
  const lowMs = low * time.multiplierMs + shift;
  const highMs = high * time.multiplierMs + shift;
  const ticks: TimeTick[] = [];
  let month: string | undefined;
  for (
    let instant = Math.ceil(lowMs / stepMs) * stepMs;
    instant <= highMs && ticks.length <= 400;
    instant += stepMs
  ) {
    const date = new Date(instant);
    const major = instant % 86_400_000 === 0;
    const name = date.toLocaleString("en", { month: "short", timeZone: "UTC" });
    ticks.push({
      value: (instant - shift) / time.multiplierMs,
      major,
      primary: twoDigits(major ? date.getUTCDate() : date.getUTCHours()),
      month: major && name !== month ? name : undefined,
    });
    if (major) month = name;
  }
  return ticks;
}

export function timeTickLabel(
  value: number,
  time: TimeDescription,
  axisSpan: number,
): TimeTickLabel {
  const date = localDate(value, time);
  const hour = twoDigits(date.getUTCHours());
  const minute = date.getUTCMinutes();
  const clock = `${hour}${minute ? `:${twoDigits(minute)}` : ""}${time.zoneLabel === "UTC" ? "Z" : ""}`;
  if (Math.abs(axisSpan * time.multiplierMs) < 86_400_000) return { primary: clock };
  const day = twoDigits(date.getUTCDate());
  const month = date.toLocaleString("en", { month: "short", timeZone: "UTC" });
  return {
    primary: `${day} ${month}`,
    secondary: minute === 0 && hour === "00" ? undefined : clock,
    day: true,
  };
}

export function formatTimestamp(value: number, time: TimeDescription): string {
  const date = localDate(value, time);
  return [
    `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`,
    `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}`,
    time.zoneLabel,
  ].join(" ");
}

function localDate(value: number, time: TimeDescription): Date {
  return new Date(time.originMs + value * time.multiplierMs + time.offsetMinutes * 60_000);
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `${sign}${twoDigits(Math.floor(absolute / 60))}:${twoDigits(absolute % 60)}`;
}
