import assert from "node:assert/strict";
import test from "node:test";

import type { Metadata, Variable } from "./model.ts";
import { formatPosition, geographicPosition } from "./projection.ts";

const projected: Variable = {
  path: "/water_level",
  name: "water_level",
  dtype: "f32",
  dimensions: [{ path: "/node", name: "node", length: 3 }],
  attributes: [],
  view_hint: {
    kind: "ugrid2d",
    mesh: "/Mesh2D",
    x: "/Mesh2D_node_x",
    y: "/Mesh2D_node_y",
    face_node_connectivity: "/Mesh2D_face_nodes",
    location: "node",
  },
};

const metadata: Metadata = {
  dataset: { name: "mesh.nc" },
  limits: { max_response_bytes: 1, ugrid_warn_faces: 1 },
  groups: [{
    path: "/",
    name: "/",
    attributes: [{
      name: "projection",
      dtype: "string",
      value: "+proj=aeqd +lat_0=23.100766 +lon_0=113.848495 +datum=WGS84 +units=m",
    }],
  }],
  dimensions: [],
  variables: [
    projected,
    { path: "/Mesh2D_node_x", name: "Mesh2D_node_x", dtype: "f64", dimensions: projected.dimensions, attributes: [{ name: "units", dtype: "string", value: "m" }], view_hint: { kind: "plain" } },
    { path: "/Mesh2D_node_y", name: "Mesh2D_node_y", dtype: "f64", dimensions: projected.dimensions, attributes: [{ name: "units", dtype: "string", value: "m" }], view_hint: { kind: "plain" } },
  ],
  warnings: [],
};

test("converts the dataset's WGS84 azimuthal-equidistant coordinates", () => {
  assert.deepEqual(geographicPosition(metadata, projected, 0, 0), {
    latitude: 23.100766,
    longitude: 113.848495,
  });
  const east = geographicPosition(metadata, projected, 1_000, 0)!;
  assert.ok(east.longitude > 113.848495);
  assert.ok(Math.abs(east.latitude - 23.100766) < 0.001);

  const reportedProbe = geographicPosition(metadata, projected, 193_327.391, -244_267.359)!;
  assert.ok(Math.abs(reportedProbe.latitude - 20.88403) < 0.00001);
  assert.ok(Math.abs(reportedProbe.longitude - 115.70609) < 0.00001);
});

test("formats geographic fields as latitude then longitude", () => {
  const geographic = {
    ...projected,
    view_hint: { ...projected.view_hint, x: "/lon", y: "/lat" },
  } satisfies Variable;
  const direct = {
    ...metadata,
    variables: [
      geographic,
      { path: "/lon", name: "lon", dtype: "f32", dimensions: projected.dimensions, attributes: [{ name: "units", dtype: "string", value: "degrees_east" }], view_hint: { kind: "plain" } },
      { path: "/lat", name: "lat", dtype: "f32", dimensions: projected.dimensions, attributes: [{ name: "units", dtype: "string", value: "degrees_north" }], view_hint: { kind: "plain" } },
    ],
  } satisfies Metadata;
  assert.equal(formatPosition(direct, geographic, 110, 23), "23°N · 110°E");
});
