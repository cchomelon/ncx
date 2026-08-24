import assert from "node:assert/strict";
import test from "node:test";

import {
  colorForValue,
  colormapClass,
  COLORMAP_GROUPS,
  defaultColormap,
  finiteRange,
  needsSymmetricRange,
  paletteBytes,
} from "./color.ts";

const USHOW_COLORMAPS = [
  "viridis", "hot", "grayscale",
  "algae", "amp", "balance", "curl", "deep", "delta", "dense", "diff", "gray", "haline",
  "ice", "matter", "oxy", "phase", "rain", "solar", "speed", "tarn", "tempo", "thermal",
  "topo", "turbid",
];

test("offers every uShow scheme in the ncview legacy group", () => {
  const group = COLORMAP_GROUPS.find((candidate) => candidate.label === "ncview legacy");
  assert.ok(group);
  assert.deepEqual(group.options.map((option) => option.value), USHOW_COLORMAPS);
  for (const option of group.options) assert.equal(paletteBytes(option.value).length, 256 * 4);
});

test("keeps missing values out of every colour scale", () => {
  const values = Float32Array.of(Number.NaN, -2, 4);
  assert.deepEqual(finiteRange(values, "batlow"), { minimum: -2, maximum: 4 });
  assert.deepEqual(finiteRange(values, "vik"), { minimum: -4, maximum: 4 });
  assert.equal(colorForValue(Number.NaN, { minimum: 1, maximum: 4 }, "linear", "batlow"), undefined);
  assert.equal(colorForValue(0, { minimum: 1, maximum: 4 }, "log", "batlow"), undefined);
});

test("every map whose midpoint means zero gets a symmetric range", () => {
  // Not just one map named "balance": the rule follows Crameri's class, so a
  // diverging or multi-sequential map can never be centred on 0.95 by accident.
  for (const name of ["vik", "berlin", "oleron"] as const) {
    assert.equal(needsSymmetricRange(name), true, name);
    assert.deepEqual(finiteRange(Float32Array.of(-0.5, 2.25), name), { minimum: -2.25, maximum: 2.25 });
  }
  for (const name of ["batlow", "lajolla", "grayC", "romaO"] as const) {
    assert.equal(needsSymmetricRange(name), false, name);
  }
  assert.deepEqual(finiteRange(Float32Array.of(-0.5, 2.25), "batlow"), {
    minimum: -0.5,
    maximum: 2.25,
  });
});

test("reversing a map mirrors it end to end", () => {
  const range = { minimum: 0, maximum: 1 };
  assert.deepEqual(
    colorForValue(0, range, "linear", "oslo_r"),
    colorForValue(1, range, "linear", "oslo"),
  );
  assert.equal(colormapClass("oslo_r"), "sequential");
});

test("sequential maps rise monotonically in lightness", () => {
  // The one property that makes a ramp readable as a ramp, and the one a
  // rainbow fails. Checked here because a bad regeneration of scm.ts would
  // otherwise be invisible until someone printed a figure in greyscale.
  const luminance = ([r, g, b]: readonly [number, number, number]) =>
    0.2126 * (r / 255) ** 2.2 + 0.7152 * (g / 255) ** 2.2 + 0.0722 * (b / 255) ** 2.2;
  for (const name of ["batlow", "lajolla", "grayC"] as const) {
    const bytes = paletteBytes(name);
    let previous = -1;
    for (let index = 0; index < 256; index += 1) {
      const value = luminance([bytes[index * 4], bytes[index * 4 + 1], bytes[index * 4 + 2]]);
      assert.ok(value >= previous - 1e-3, `${name} dips in lightness at ${index}`);
      previous = value;
    }
  }
});

test("picks the map from CF metadata, not from the reader", () => {
  assert.equal(defaultColormap({ standardName: "sea_water_temperature" }), "lajolla");
  assert.equal(defaultColormap({ standardName: "sea_floor_depth_below_geoid" }), "oslo_r");
  assert.equal(defaultColormap({ standardName: "surface_altitude" }), "oleron");
  assert.equal(defaultColormap({ standardName: "wind_from_direction" }), "romaO");
  assert.equal(defaultColormap({ longName: "sea surface height anomaly" }), "vik");
  assert.equal(defaultColormap({ name: "u10" }), "batlow");
  // An anomaly of a temperature is not a temperature.
  assert.equal(defaultColormap({ standardName: "sea_water_temperature_anomaly" }), "vik");
  // Nobody said so, but the values straddle zero.
  assert.equal(defaultColormap({ name: "w" }, { minimum: -3, maximum: 2 }), "vik");
});
