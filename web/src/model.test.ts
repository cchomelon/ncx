import assert from "node:assert/strict";
import test from "node:test";

import type { Metadata, Variable } from "./model.ts";
import { meshGeometryPaths } from "./model.ts";

const variable = (name: string, attributes: Variable["attributes"] = []): Variable => ({
  path: `/${name}`,
  name,
  dtype: "f32",
  dimensions: [],
  attributes,
  view_hint: { kind: "plain" },
});

test("identifies UGRID geometry without hiding mesh data fields", () => {
  const topology = variable("Mesh2D", [
    { name: "cf_role", dtype: "string", value: "mesh_topology" },
    { name: "node_coordinates", dtype: "string", value: "Mesh2D_node_x Mesh2D_node_y" },
    { name: "face_node_connectivity", dtype: "string", value: "Mesh2D_face_nodes" },
  ]);
  const field = variable("water_level", [
    { name: "mesh", dtype: "string", value: "Mesh2D" },
    { name: "location", dtype: "string", value: "face" },
  ]);
  const depth = variable("Mesh2D_node_depth", [
    { name: "mesh", dtype: "string", value: "Mesh2D" },
    { name: "location", dtype: "string", value: "node" },
  ]);
  const metadata = {
    variables: [
      topology,
      variable("Mesh2D_node_x"),
      variable("Mesh2D_node_y"),
      variable("Mesh2D_face_nodes", [{ name: "cf_role", dtype: "string", value: "face_node_connectivity" }]),
      depth,
      field,
    ],
  } as Metadata;

  assert.deepEqual(
    [...meshGeometryPaths(metadata)].sort(),
    ["/Mesh2D", "/Mesh2D_face_nodes", "/Mesh2D_node_depth", "/Mesh2D_node_x", "/Mesh2D_node_y"],
  );
});
