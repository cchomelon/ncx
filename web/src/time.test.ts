import assert from "node:assert/strict";
import test from "node:test";

import type { Variable } from "./model.ts";
import {
  UTC_TIME_ZONE,
  describeTime,
  formatTimestamp,
  parseDisplayTimeZone,
  timeInZone,
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
