import assert from "node:assert/strict";
import test from "node:test";

import { colorForValue, finiteRange } from "./color.ts";

test("keeps missing values out of every colour scale", () => {
  const values = Float32Array.of(Number.NaN, -2, 4);
  assert.deepEqual(finiteRange(values, "viridis"), { minimum: -2, maximum: 4 });
  assert.deepEqual(finiteRange(values, "balance"), { minimum: -4, maximum: 4 });
  assert.equal(colorForValue(Number.NaN, { minimum: 1, maximum: 4 }, "linear", "viridis"), undefined);
  assert.equal(colorForValue(0, { minimum: 1, maximum: 4 }, "log", "viridis"), undefined);
});
