import assert from "node:assert/strict";
import test from "node:test";

import type { Variable } from "./model.ts";
import { describeTime, formatTimestamp, timeTickLabel } from "./time.ts";

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
  assert.equal(formatTimestamp(18, time), "2024-07-25 18:00 HKT");
  assert.deepEqual(timeTickLabel(0, time), { primary: "25", month: "JUL", day: true });
  assert.deepEqual(timeTickLabel(6, time), { primary: "06" });
});

test("accepts the common UTC suffix used by CF files", () => {
  const utcVariable = {
    ...variable,
    attributes: [{ name: "units", dtype: "string", value: "hours since 2024-07-25 00:00:00 UTC" }],
  };
  const time = describeTime(utcVariable);
  assert.ok(time);
  assert.equal(formatTimestamp(6, time), "2024-07-25 06:00 UTC");
});
