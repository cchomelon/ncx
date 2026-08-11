import assert from "node:assert/strict";
import test from "node:test";

import type { Variable } from "./model.ts";
import { curveRequest, defaultDisplayDimensions, fieldRequest, ugridFieldRequest } from "./selection.ts";

const variable: Variable = {
  path: "/temperature",
  name: "temperature",
  dtype: "i16",
  dimensions: [
    { path: "/time", name: "time", length: 241 },
    { path: "/level", name: "level", length: 20 },
    { path: "/y", name: "y", length: 2000 },
    { path: "/x", name: "x", length: 3000 },
  ],
  attributes: [],
  view_hint: { kind: "plain" },
};

test("maps display dimensions and indices to the thin data API", () => {
  const display = defaultDisplayDimensions(variable);
  const request = fieldRequest(
    variable,
    display,
    { "/time": 120, "/level": 4 },
    { width: 800, height: 600 },
    false,
  );

  assert.deepEqual(display, { x: 3, y: 2 });
  assert.equal(request.selection, "120,4,:,:");
  assert.equal(request.stride, "1,1,4,4");
});

test("a curve ranges one dimension and fixes every other dimension", () => {
  const request = curveRequest(variable, 0, {
    "/level": 4,
    "/y": 100,
    "/x": 200,
  });
  assert.equal(request.selection, ":,4,100,200");
  assert.equal(request.stride, "1,1,1,1");
});

test("UGRID never invents a spatial preview stride", () => {
  const request = ugridFieldRequest(variable, 3, { "/time": 12, "/level": 4, "/y": 9 });
  assert.equal(request.selection, "12,4,9,:");
  assert.equal(request.stride, "1,1,1,1");
});
