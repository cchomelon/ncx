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
      location: "node" | "edge" | "face";
    };

export interface Variable {
  dataset_id?: string;
  path: string;
  name: string;
  dtype: string;
  dimensions: VariableDimension[];
  attributes: Attribute[];
  view_hint: ViewHint;
}

export interface Metadata {
  dataset_id: string;
  dataset_label: string;
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
  dataset?: string;
  path: string;
  selection: string;
  stride: string;
}

export interface DatasetSummary {
  id: string;
  label: string;
  name: string;
  variables: number;
  dimensions: number;
  warnings: number;
}

export interface DataSlice {
  dtype: "f32" | "i32" | "u32";
  shape: number[];
  values: Float32Array | Int32Array | Uint32Array;
  request: SliceRequest;
}

export interface ComparisonSeries {
  id: string;
  label: string;
  quantity: string;
  location_id: string;
  x_units: string;
  x: number[];
  y_units: string;
  vertical_datum?: string;
  primary_y_offset?: number;
  y: number[];
}

export interface Probe {
  indices: Record<string, number>;
  average?: { dimension: string; indices: number[] };
  x: number;
  y: number;
  value: number;
  latitude?: number;
  longitude?: number;
}

export type ViewName = "field" | "curve" | "compare" | "metadata";
export type ColorScale = "linear" | "log" | "symlog";
// Colormap lives in ./color, beside the tables it names: the set of legal
// values is a property of the colour data, not of the dataset model.

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

const UNIT_NAMES: Record<string, string> = {
  "1": "",
  degree_celsius: "°C",
  degrees_celsius: "°C",
  degc: "°C",
  celsius: "°C",
  degrees_north: "°N",
  degrees_east: "°E",
  degree_north: "°N",
  degree_east: "°E",
  percent: "%",
};

const SUPERSCRIPTS: Record<string, string> = {
  "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};

/**
 * A CF units string as it should be read: `degree_Celsius` is °C, and
 * `m s-1` carries a real superscript rather than a stray hyphen that reads as
 * a minus sign. Dimensionless units render as nothing at all, since "1" beside
 * a quantity looks like part of the number.
 */
export function formatUnit(units: string): string {
  const trimmed = units.trim();
  const named = UNIT_NAMES[trimmed.toLowerCase()];
  if (named !== undefined) return named;
  return trimmed.replace(/([A-Za-z)])(-?\d+)(?![\w.])/g, (_, head: string, exponent: string) =>
    head + [...exponent].map((character) => SUPERSCRIPTS[character] ?? character).join(""),
  );
}

/** The unit of `variable`, formatted for display; empty when dimensionless. */
export function displayUnit(variable: Variable): string {
  return formatUnit(variableUnit(variable));
}

/**
 * `Quantity (unit)`, the axis and colourbar label pattern from Style: sentence
 * case, unit in parentheses. Brackets would be wrong — in SI usage `[x]` means
 * "the dimension of x", so `Depth [m]` says "depth is a length".
 */
export function quantityLabel(variable: Variable): string {
  const label = sentenceCase(variableLabel(variable));
  const unit = displayUnit(variable);
  return unit ? `${label} (${unit})` : label;
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Coordinate and other non-data variables: the axes, bounds, and labels a file
 * carries to describe its data rather than to be plotted itself.
 */
export function coordinateVariablePaths(metadata: Metadata): Set<string> {
  const paths = new Set<string>();
  const dimensionPaths = new Set(metadata.dimensions.map((dimension) => dimension.path));
  for (const variable of metadata.variables) {
    const axis = attributeText(variable, "axis");
    const standard = attributeText(variable, "standard_name") ?? "";
    const units = attributeText(variable, "units") ?? "";
    if (
      // A coordinate variable: one dimension, sharing its own name.
      (variable.dimensions.length === 1 && dimensionPaths.has(variable.path)) ||
      (axis !== undefined && /^[XYZT]$/i.test(axis)) ||
      ["longitude", "latitude", "time", "depth", "altitude"].includes(standard) ||
      /^degrees_(north|east)$/.test(units)
    ) {
      paths.add(variable.path);
    }
  }
  for (const variable of metadata.variables) {
    for (const attribute of ["coordinates", "bounds", "climatology"]) {
      const value = attributeText(variable, attribute);
      if (!value) continue;
      for (const reference of value.split(/\s+/)) {
        if (reference) paths.add(resolveVariableReference(variable.path, reference));
      }
    }
  }
  return paths;
}

export function isNumeric(variable: Variable): boolean {
  return /^(u|i)(8|16|32|64)$|^f(32|64)$/.test(variable.dtype);
}

export function isTimeCoordinate(variable: Variable): boolean {
  return attributeText(variable, "axis")?.toUpperCase() === "T" ||
    attributeText(variable, "standard_name") === "time";
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
  }
  return paths;
}

/** Viewer-only paths folded away by default; the NetCDF metadata stays untouched. */
export function supportingVariablePaths(metadata: Metadata): Set<string> {
  return new Set([...coordinateVariablePaths(metadata), ...meshGeometryPaths(metadata)]);
}

/**
 * The variable to open a file on: the one a reader most likely came for.
 *
 * Ranked by whether it is data at all, then by how much of it there is to look
 * at — a griddable field beats a bare array, and a field that evolves through
 * time beats a static one. Coordinates and mesh geometry are never chosen;
 * they describe the data rather than being it.
 */
export function defaultVariable(metadata: Metadata): Variable | undefined {
  const excluded = supportingVariablePaths(metadata);
  const candidates = metadata.variables.filter(isNumeric);
  const data = candidates.filter(
    (variable) => !excluded.has(variable.path) && variable.dimensions.every((dimension) => dimension.length > 0),
  );
  const score = (variable: Variable) => {
    const griddable = variable.view_hint.kind !== "plain";
    const animated = variable.dimensions.some((dimension) =>
      metadata.variables.some(
        (candidate) =>
          candidate.path === dimension.path &&
          isTimeCoordinate(candidate),
      ),
    );
    return (
      (griddable ? 8 : 0) +
      (animated ? 4 : 0) +
      Math.min(3, Math.max(0, variable.dimensions.length - 1))
    );
  };
  const ranked = [...data].sort((first, second) => score(second) - score(first));
  return ranked[0] ?? candidates[0];
}

export function resolveVariableReference(ownerPath: string, reference: string): string {
  if (reference.startsWith("/")) return reference;
  const parent = ownerPath.slice(0, ownerPath.lastIndexOf("/"));
  return `${parent}/${reference}`;
}
