import assert from "node:assert/strict";
import test from "node:test";

import { buildCurvilinearGeometry, buildUgridGeometry, edgesToFaces, findMeshHit } from "./mesh.ts";

test("omits curvilinear quads with invalid coordinates", () => {
  const x = Float32Array.of(0, 1, 2, 0, 1, 2);
  const y = Float32Array.of(0, 0, 0, 1, 1, Number.NaN);
  const geometry = buildCurvilinearGeometry(x, y, 2, 3, 2, 3, 1, 1);
  assert.equal(geometry.triangleSources.length, 2);
  assert.equal(findMeshHit(geometry, 0.25, 0.25)?.scalarIndex, 0);
});

test("normalizes padded one-based UGRID polygons and preserves face scalars", () => {
  const x = Float32Array.of(0, 2, 2, 1, 0);
  const y = Float32Array.of(0, 0, 2, 1, 2);
  const connectivity = Int32Array.of(1, 2, 3, 4, 5, -1);
  const geometry = buildUgridGeometry(x, y, connectivity, 1, 6, 1, [-1], "face");
  assert.equal(geometry.triangleSources.length, 3);
  assert.deepEqual([...new Set(geometry.scalarIndices)], [0]);
});

test("averages edge values onto their adjacent faces", () => {
  assert.deepEqual(
    [...edgesToFaces(Float32Array.of(2, 4, 8), Int32Array.of(0, -1, 0, 1, 1, -1), 2)],
    [3, 6],
  );
  assert.ok(Number.isNaN(edgesToFaces(Float32Array.of(2), Int32Array.of(-1, -1), 1)[0]));
  assert.throws(() => edgesToFaces(Float32Array.of(2), Int32Array.of(0), 1), /two faces per edge/);
});

test("keeps UGRID node scalars and rejects out-of-range connectivity", () => {
  const x = Float32Array.of(0, 1, 0);
  const y = Float32Array.of(0, 0, 1);
  const geometry = buildUgridGeometry(x, y, Int32Array.of(1, 2, 3), 1, 3, 1, [], "node");
  assert.deepEqual([...geometry.scalarIndices], [0, 1, 2]);
  assert.throws(
    () => buildUgridGeometry(x, y, Int32Array.of(1, 2, 4), 1, 3, 1, [], "node"),
    /invalid node 4/,
  );
});

test("keeps hover probing available above one hundred thousand triangles", () => {
  const side = 230;
  const x = new Float32Array(side * side);
  const y = new Float32Array(side * side);
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      x[row * side + column] = column;
      y[row * side + column] = row;
    }
  }
  const geometry = buildCurvilinearGeometry(x, y, side, side, side, side, 1, 1);
  assert.ok(geometry.triangleSources.length > 100_000);
  assert.ok(findMeshHit(geometry, 114.25, 114.25));
});
