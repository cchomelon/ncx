import assert from "node:assert/strict";
import test from "node:test";

import type { Variable } from "./model.ts";
import {
  UTC_TIME_ZONE,
  describeTime,
  formatTimestamp,
  parseDisplayTimeZone,
  timeInZone,
  timeAxisTicks,
  timeTickLabel,
} from "./time.ts";

const variable: Variable = {
  path: "/time",
  name: "time",
  dtype: "f32",
  dimensions: [{ path: "/time", name: "time", length: 4 }],
  attributes: [
    {
      name: "units",
      dtype: "string",
      value: "hours since 2024-07-25 00:00:00 +08:00",
    },
  ],
  view_hint: { kind: "plain" },
};

test("formats CF time once for titles, curves, and the timeline", () => {
  const time = describeTime(variable);
  assert.ok(time);
  assert.equal(formatTimestamp(18, time), "2024-07-25 18:00 UTC+08:00");
  assert.deepEqual(timeTickLabel(0, time, 18), { primary: "00" });
  assert.deepEqual(timeTickLabel(6, time, 18), { primary: "06" });
});

test("accepts the common UTC suffix used by CF files", () => {
  const utcVariable = {
    ...variable,
    attributes: [{ name: "units", dtype: "string", value: "hours since 2024-07-25 00:00:00 UTC" }],
  };
  const time = describeTime(utcVariable);
  assert.ok(time);
  assert.equal(formatTimestamp(6, time), "2024-07-25 06:00 UTC");
  assert.deepEqual(timeTickLabel(0, time, 18), { primary: "00Z" });
  assert.deepEqual(timeTickLabel(6, time, 18), { primary: "06Z" });
});

test("uses Style date-time labels without repeating one UTC hour across days", () => {
  const utcVariable = {
    ...variable,
    attributes: [{ name: "units", dtype: "string", value: "hours since 2024-07-25 06:00:00 UTC" }],
  };
  const time = describeTime(utcVariable);
  assert.ok(time);
  assert.deepEqual([0, 24, 48].map((value) => timeTickLabel(value, time, 48)), [
    { primary: "25 Jul", secondary: "06Z", day: true },
    { primary: "26 Jul", secondary: "06Z", day: true },
    { primary: "27 Jul", secondary: "06Z", day: true },
  ]);
});

test("the curve time axis majors on midnight and names the month once", () => {
  const utcVariable = {
    ...variable,
    attributes: [{ name: "units", dtype: "string", value: "hours since 2024-09-19 00:00:00 UTC" }],
  };
  const time = describeTime(utcVariable);
  assert.ok(time);
  // 24 to 51 hours after the origin is 20 Sep 00Z through 21 Sep 03Z.
  const ticks = timeAxisTicks(24, 51, time, 3);
  assert.deepEqual(
    ticks.map((tick) => [tick.primary, tick.major, tick.month]),
    [
      ["20", true, "Sep"],
      ["03", false, undefined],
      ["06", false, undefined],
      ["09", false, undefined],
      ["12", false, undefined],
      ["15", false, undefined],
      ["18", false, undefined],
      ["21", false, undefined],
      ["21", true, undefined],
      ["03", false, undefined],
    ],
  );
  // No label carries a zone suffix, and midnight never prints as an hour.
  assert.ok(ticks.every((tick) => !tick.primary.includes("Z")));
  assert.ok(ticks.every((tick) => tick.major || tick.primary !== "00"));
});

test("the curve time axis names the month again when it turns", () => {
  const utcVariable = {
    ...variable,
    attributes: [{ name: "units", dtype: "string", value: "hours since 2024-09-30 00:00:00 UTC" }],
  };
  const time = describeTime(utcVariable);
  assert.ok(time);
  const months = timeAxisTicks(0, 48, time, 24).map((tick) => tick.month);
  assert.deepEqual(months, ["Sep", "Oct", undefined]);
});

test("the curve time axis coarsens the step when the panel is narrow", () => {
  const time = describeTime(variable);
  assert.ok(time);
  const spacing = (step: number) => {
    const ticks = timeAxisTicks(0, 240, time, step);
    return ticks[1].value - ticks[0].value;
  };
  assert.equal(spacing(1), 1);
  assert.equal(spacing(3), 3);
  assert.equal(spacing(4), 6);
  assert.equal(spacing(13), 24);
});

test("changes display timezone without changing the CF time instant", () => {
  const sourceTime = describeTime(variable);
  const utcTime = timeInZone(sourceTime, UTC_TIME_ZONE);
  assert.ok(utcTime);
  assert.equal(formatTimestamp(0, utcTime), "2024-07-24 16:00 UTC");

  const hkt = parseDisplayTimeZone("HKT,480");
  assert.ok(hkt);
  const hktTime = timeInZone(utcTime, hkt);
  assert.ok(hktTime);
  assert.equal(formatTimestamp(0, hktTime), "2024-07-25 00:00 HKT");
});

test("accepts one bounded caller-defined fixed display zone", () => {
  assert.deepEqual(parseDisplayTimeZone("HKT,480"), {
    label: "HKT",
    offsetMinutes: 480,
  });
  for (const value of [null, "", "HKT", "HKT,900", "UTC,480", "bad label,60"]) {
    assert.equal(parseDisplayTimeZone(value), undefined);
  }
});

test("does not mislabel a non-Gregorian CF calendar as UTC", () => {
  const modelCalendar = {
    ...variable,
    attributes: [
      ...variable.attributes,
      { name: "calendar", dtype: "string", value: "360_day" },
    ],
  };
  assert.equal(describeTime(modelCalendar), undefined);
});
