import type { SliceRequest, Variable } from "./model";

export const PREVIEW_SAMPLES_PER_AXIS = 1000;
export const SETTLE_DELAY_MS = 250;
export const MAX_FULL_RESOLUTION_SAMPLES = 4_000_000;

export interface DisplayDimensions {
  x: number | undefined;
  y: number | undefined;
}

export function defaultDisplayDimensions(variable: Variable): DisplayDimensions {
  const rank = variable.dimensions.length;
  if (rank === 0) return { x: undefined, y: undefined };
  if (variable.view_hint.kind === "ugrid2d") return { x: rank - 1, y: undefined };
  if (rank === 1) return { x: 0, y: undefined };
  return { x: rank - 1, y: rank - 2 };
}

export function defaultIndices(variable: Variable): Record<string, number> {
  return Object.fromEntries(variable.dimensions.map((dimension) => [dimension.path, 0]));
}

export function fieldRequest(
  variable: Variable,
  display: DisplayDimensions,
  indices: Record<string, number>,
  viewport: { width: number; height: number },
  settled: boolean,
): SliceRequest {
  const fullResolutionSamples = variable.dimensions.reduce((total, dimension, index) => {
    return index === display.x || index === display.y ? total * dimension.length : total;
  }, 1);
  // ponytail: avoid allocating a multi-hundred-MB browser slice; add tiled
  // structured reads when datasets need full resolution beyond this ceiling.
  const requestFullResolution =
    settled && fullResolutionSamples <= MAX_FULL_RESOLUTION_SAMPLES;

  const selection: string[] = [];
  const stride: string[] = [];
  variable.dimensions.forEach((dimension, index) => {
    const displayed = index === display.x || index === display.y;
    selection.push(displayed ? ":" : String(clampIndex(indices[dimension.path], dimension.length)));
    const pixels = index === display.x ? viewport.width : viewport.height;
    stride.push(
      displayed && !requestFullResolution
        ? String(previewStride(dimension.length, pixels))
        : "1",
    );
  });
  return { path: variable.path, selection: selection.join(","), stride: stride.join(",") };
}

export function curveRequest(
  variable: Variable,
  curveDimension: number,
  indices: Record<string, number>,
): SliceRequest {
  const selection = variable.dimensions.map((dimension, index) =>
    index === curveDimension ? ":" : String(clampIndex(indices[dimension.path], dimension.length)),
  );
  return {
    path: variable.path,
    selection: selection.join(","),
    stride: variable.dimensions.map(() => "1").join(","),
  };
}

/** UGRID has no implicit LOD: range its node/face dimension at stride one. */
export function ugridFieldRequest(
  variable: Variable,
  spatialDimension: number,
  indices: Record<string, number>,
): SliceRequest {
  return curveRequest(variable, spatialDimension, indices);
}

export function previewStride(length: number, viewportPixels: number): number {
  const availablePixels = Math.max(1, Math.min(PREVIEW_SAMPLES_PER_AXIS, viewportPixels));
  return Math.max(1, Math.ceil(length / availablePixels));
}

function clampIndex(value: number | undefined, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.round(value ?? 0)));
}
