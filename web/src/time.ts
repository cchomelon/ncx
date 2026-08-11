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
  day?: boolean;
  month?: string;
}

export function describeTime(variable: Variable | undefined): TimeDescription | undefined {
  if (!variable) return undefined;
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
    zoneLabel:
      offsetMinutes === 480
        ? "HKT"
        : offsetMinutes === 0
          ? "UTC"
          : `UTC${formatOffset(offsetMinutes)}`,
  };
}

export function timeTickLabel(value: number, time: TimeDescription): TimeTickLabel {
  const date = localDate(value, time);
  const hour = date.getUTCHours();
  return hour === 0
    ? {
        primary: String(date.getUTCDate()).padStart(2, "0"),
        month: date
          .toLocaleString("en", { month: "short", timeZone: "UTC" })
          .toUpperCase(),
        day: true,
      }
    : { primary: String(hour).padStart(2, "0") };
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
