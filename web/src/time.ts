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
