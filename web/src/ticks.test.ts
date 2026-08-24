import assert from "node:assert/strict";
import test from "node:test";

import { axisTicks, formatTick, niceStep, niceTicks, tickCountForLength } from "./ticks.ts";

test("ticks land on readable steps rather than domain fractions", () => {
  assert.equal(niceStep(0.31), 0.5);
  assert.equal(niceStep(13.5), 20);
  // The rectilinear fixture's latitude span: fractions gave 18.75 and 22.25.
  assert.deepEqual(niceTicks(17, 24, 4), [18, 20, 22, 24]);
  // Fractions of this span gave 110, 113, 116, 119, 122.
  assert.deepEqual(niceTicks(110, 122, 4), [110, 115, 120]);
});

const labels = (minimum: number, maximum: number, count: number) => {
  const { values, format } = axisTicks(minimum, maximum, count);
  return values.map(format);
};

test("every label on one axis shares the precision of its step", () => {
  // The gauge curve's y domain: fractions gave 1.094e-6, 0.14, 0.28, 0.419.
  assert.deepEqual(labels(0, 0.559, 4), ["0.0", "0.2", "0.4"]);
  assert.deepEqual(labels(17, 24, 4), ["18", "20", "22", "24"]);
});

test("zero never prints as a negative or as float noise", () => {
  assert.equal(formatTick(-1e-17, 0.1), "0.0");
  assert.equal(formatTick(0, 1), "0");
  assert.ok(!labels(-0.3, 0.3, 4).includes("-0.0"));
  assert.ok(labels(-0.3, 0.3, 4).includes("0.0"));
});

test("unreadable magnitudes fall back to exponential", () => {
  assert.equal(formatTick(101_325, 5000), "1.01e5");
  assert.equal(formatTick(0.0000031, 1e-6), "3.1e-6");
});

test("a degenerate domain still labels its single value", () => {
  assert.deepEqual(niceTicks(5, 5), [5]);
  assert.deepEqual(niceTicks(Number.NaN, 1), []);
});

test("tick density follows the room the axis actually has", () => {
  assert.equal(tickCountForLength(120), 2);
  assert.ok(tickCountForLength(1200) > tickCountForLength(400));
  assert.equal(tickCountForLength(100_000), 11);
});
