export type AttributeScalar = number | string;

export interface Attribute {
  name: string;
  dtype: string;
  value: AttributeScalar | AttributeScalar[];
  truncated?: boolean;
}

export interface Dimension {
  path: string;
  name: string;
  length: number;
  unlimited: boolean;
}

export interface VariableDimension {
  path: string;
  name: string;
  length: number;
}

export type ViewHint =
  | { kind: "plain" }
  | { kind: "rectilinear"; x: string; y: string }
  | { kind: "curvilinear"; x: string; y: string }
  | {
      kind: "ugrid2d";
      mesh: string;
      x: string;
      y: string;
      face_node_connectivity: string;
      location: "node" | "face";
    };

export interface Variable {
  path: string;
  name: string;
  dtype: string;
  dimensions: VariableDimension[];
  attributes: Attribute[];
  view_hint: ViewHint;
}

export interface Metadata {
  dataset: { name: string };
  limits: {
    max_response_bytes: number;
    ugrid_warn_faces: number;
  };
  groups: Array<{ path: string; name: string; attributes: Attribute[] }>;
  dimensions: Dimension[];
  variables: Variable[];
  warnings: string[];
}

export interface SliceRequest {
  path: string;
  selection: string;
  stride: string;
}

export interface DataSlice {
  dtype: "f32" | "i32" | "u32";
  shape: number[];
  values: Float32Array | Int32Array | Uint32Array;
  request: SliceRequest;
}

export interface Probe {
  indices: Record<string, number>;
  x: number;
  y: number;
  value: number;
  latitude?: number;
  longitude?: number;
}

export type ViewName = "field" | "curve" | "metadata";
export type ColorScale = "linear" | "log" | "symlog";
export type Colormap = "viridis" | "thermal" | "balance" | "grayscale";

export function attributeText(owner: { attributes: Attribute[] }, name: string): string | undefined {
  const value = owner.attributes.find((attribute) => attribute.name === name)?.value;
  return typeof value === "string" ? value : undefined;
}

export function attributeNumbers(variable: Variable, name: string): number[] {
  const value = variable.attributes.find((attribute) => attribute.name === name)?.value;
  if (typeof value === "number") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number");
}

export function attributeNumber(variable: Variable, name: string): number | undefined {
  return attributeNumbers(variable, name)[0];
}

export function variableLabel(variable: Variable): string {
  return (
    attributeText(variable, "long_name") ??
    attributeText(variable, "standard_name") ??
    variable.name.replaceAll("_", " ")
  );
}

export function variableUnit(variable: Variable): string {
  return attributeText(variable, "units") ?? "1";
}

export function isNumeric(variable: Variable): boolean {
  return /^(u|i)(8|16|32|64)$|^f(32|64)$/.test(variable.dtype);
}

export function meshGeometryPaths(metadata: Metadata): Set<string> {
  const paths = new Set<string>();
  const topologies = metadata.variables.filter(
    (variable) => attributeText(variable, "cf_role") === "mesh_topology",
  );
  for (const topology of topologies) {
    paths.add(topology.path);
    for (const attribute of topology.attributes) {
      if (
        typeof attribute.value !== "string" ||
        (!attribute.name.includes("coordinates") && !attribute.name.includes("connectivity"))
      ) {
        continue;
      }
      for (const reference of attribute.value.split(/\s+/)) {
        if (reference) paths.add(resolveVariableReference(topology.path, reference));
      }
    }
  }
  for (const variable of metadata.variables) {
    const role = attributeText(variable, "cf_role") ?? "";
    if (role.endsWith("_connectivity") || role === "location_index_set") {
      paths.add(variable.path);
    }
    if (topologies.some((topology) => variable.name.startsWith(`${topology.name}_`))) {
      paths.add(variable.path);
    }
  }
  return paths;
}

export function resolveVariableReference(ownerPath: string, reference: string): string {
  if (reference.startsWith("/")) return reference;
  const parent = ownerPath.slice(0, ownerPath.lastIndexOf("/"));
  return `${parent}/${reference}`;
}
