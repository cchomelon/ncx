import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVANCE,
  COLORBAR_CHARS,
  PAD,
  tickLength,
  axisOffsets,
  colorbarGeometry,
  plotMargin,
  widestLabel,
  type PlotType,
} from "./plotgeom.ts";

/**
 * Every bug this module was written to end was the same one: a label placed at
 * a distance chosen for one font size, colliding with a column whose width
 * depends on another. So the checks are all clearance invariants, run across
 * the whole range of type sizes the clamps in `style.css` can produce and the
 * label widths CF metadata actually yields.
 */
const TYPES: PlotType[] = [
  { tick: 14, axis: 16 },   // the CSS floors, smallest panel
  { tick: 17, axis: 19 },
  { tick: 20, axis: 22 },   // a full-window panel
  { tick: 22, axis: 24 },   // the CSS ceilings
];

/** `-8e5`, `1013.2`, `-0.005`, `-180.0` -- the awkward end of CF formatting. */
const LABELS = [1, 3, 4, 6, 8];

test("the y axis title always clears its tick label column", () => {
  for (const type of TYPES) {
    for (const chars of LABELS) {
      const offset = axisOffsets(type, chars);
      const columnEdge = offset.yLabel + chars * type.tick * ADVANCE;
      assert.ok(
        offset.yTitle > columnEdge,
        `y title at ${offset.yTitle} sits inside a ${chars}-char column ending at ${columnEdge}`,
      );
    }
  }
});

test("the x axis title always clears its tick label rows", () => {
  for (const type of TYPES) {
    for (const rows of [1, 2]) {
      const offset = axisOffsets(type, 4, rows);
      assert.ok(
        offset.xTitle > offset.xRow(rows - 1),
        `x title at ${offset.xTitle} sits on row ${rows} at ${offset.xRow(rows - 1)}`,
      );
    }
  }
});

test("the colourbar caption always clears its tick label column", () => {
  for (const type of TYPES) {
    for (const chars of LABELS) {
      const bar = colorbarGeometry(type, chars);
      const columnEdge = bar.labelX + Math.max(chars, COLORBAR_CHARS) * type.tick * ADVANCE;
      assert.ok(
        bar.captionX > columnEdge,
        `caption at ${bar.captionX} sits inside a ${chars}-char column ending at ${columnEdge}`,
      );
    }
  }
});

test("a panel margin holds every piece of furniture it must", () => {
  for (const type of TYPES) {
    const bar = colorbarGeometry(type);
    const margin = plotMargin(type, { colorbar: 14 + bar.total });
    const offset = axisOffsets(type, 5);
    assert.ok(margin.left > offset.yTitle, "left margin cuts off the y title");
    assert.ok(margin.bottom > offset.xTitle, "bottom margin cuts off the x title");
    assert.ok(margin.right > bar.captionX, "right margin cuts off the colourbar caption");
  }
});

test("furniture grows with the type, never shrinks", () => {
  for (let index = 1; index < TYPES.length; index += 1) {
    const smaller = plotMargin(TYPES[index - 1]);
    const larger = plotMargin(TYPES[index]);
    assert.ok(larger.left >= smaller.left, "left margin shrank as type grew");
    assert.ok(larger.bottom >= smaller.bottom, "bottom margin shrank as type grew");
  }
});

test("a text row costs its own height plus PAD of it, as DCL stacks them", () => {
  const type: PlotType = { tick: 20, axis: 24 };
  const offset = axisOffsets(type, 0, 2);
  const row = offset.xRow(1) - offset.xRow(0);
  assert.equal(Math.round(row), Math.round(type.tick * (PAD + 1)));
});

// The DCL property: the label height is the only unit, so the same figure at
// twice the type size is the same figure. A length that stops scaling here is a
// pixel constant that has crept back into the ladder.
test("every axis offset scales with the type size", () => {
  const small: PlotType = { tick: 11, axis: 13 };
  const large: PlotType = { tick: 22, axis: 26 };
  const at = (type: PlotType) => axisOffsets(type, 5, 1);
  const a = at(small);
  const b = at(large);
  for (const key of ["xLabel", "yLabel", "xTitle", "yTitle"] as const) {
    assert.ok(
      Math.abs(b[key] / a[key] - 2) < 1e-9,
      `${key} did not double with the type: ${a[key]} -> ${b[key]}`,
    );
  }
  assert.equal(tickLength(large), 2 * tickLength(small));
});

test("widestLabel measures the longest formatted tick", () => {
  assert.equal(widestLabel([0, -8e5, 1], (value) => String(value)), 7);
  assert.equal(widestLabel([], () => ""), 0);
});
