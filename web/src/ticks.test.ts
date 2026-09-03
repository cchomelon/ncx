import assert from "node:assert/strict";
import test from "node:test";

import {
  axisTicks,
  blockGe,
  blockLe,
  formatTick,
  limitsOnTick,
  niceStep,
  niceTicks,
  tickCountForLength,
  tickLadder,
} from "./ticks.ts";

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

test("blockLe rounds an interval down onto 1/2/5, blockGe up", () => {
  assert.equal(blockLe(3), 2);
  assert.equal(blockLe(0.7), 0.5);
  assert.equal(blockGe(3), 5);
  assert.equal(blockGe(0.011), 0.02);
  assert.equal(blockLe(0), 0);
});

// design.md § Frame: dense small ticks, labelled every 2nd/5th/10th, and the
// label interval always a whole multiple of the small one.
test("the ladder is dense in small ticks and labels a whole multiple of them", () => {
  for (const [low, high, length] of [
    [0, 30, 700],
    [-8e5, 8e5, 700],
    [1013.2, 1015.8, 700],
    [0, 100, 300],
  ] as const) {
    const ladder = tickLadder(low, high, length, 14);
    const total = ladder.minor.length + ladder.major.length;
    assert.ok(total >= 15 && total <= 55, `${low}..${high} gave ${total} small ticks`);
    assert.ok(ladder.major.length >= 3, `${low}..${high} gave ${ladder.major.length} labels`);
    const labelStep = ladder.major[1] - ladder.major[0];
    const multiple = labelStep / ladder.step;
    assert.ok(
      Math.abs(multiple - Math.round(multiple)) < 1e-6 && Math.round(multiple) >= 2,
      `label step ${labelStep} is not a whole multiple >= 2 of ${ladder.step}`,
    );
    // Minor and major never occupy the same position.
    const majors = new Set(ladder.major.map((v) => Math.round(v / ladder.step)));
    assert.ok(ladder.minor.every((v) => !majors.has(Math.round(v / ladder.step))));
  }
});

test("the ladder rides the type size, as every other distance does", () => {
  const small = tickLadder(0, 100, 700, 11);
  const large = tickLadder(0, 100, 700, 22);
  assert.ok(large.step >= small.step, "larger type did not thin the ladder");
});

test("limitsOnTick grows a domain outward onto whole small ticks", () => {
  assert.deepEqual(limitsOnTick(1013.2, 1015.8, 0.5), [1013, 1016]);
  assert.deepEqual(limitsOnTick(0, 30, 1), [0, 30]);
  const [low, high] = limitsOnTick(-0.37, 0.94, 0.1);
  assert.ok(low <= -0.37 && high >= 0.94);
});
