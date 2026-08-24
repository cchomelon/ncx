import type { SliceRequest, Variable } from "./model";
import type { ViewBounds } from "./view";

export const PREVIEW_SAMPLES_PER_AXIS = 2000;
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

/**
 * The dimension a curve should sweep.
 *
 * The animated dimension first, since a curve taken at a probe is normally the
 * history of that point; then the CF time axis; then the longest dimension.
 * Falling through to the displayed x dimension instead draws a line across
 * independent samples — three sensors joined into a slope — which asserts
 * a path between them that does not exist.
 */
export function defaultCurveDimension(
  variable: Variable,
  timelineIndex: number | undefined,
  isTimeDimension: (path: string) => boolean,
): number {
  if (variable.dimensions.length === 0) return 0;
  if (timelineIndex !== undefined) return timelineIndex;
  const time = variable.dimensions.findIndex((dimension) => isTimeDimension(dimension.path));
  if (time >= 0) return time;
  let longest = 0;
  variable.dimensions.forEach((dimension, index) => {
    if (dimension.length > variable.dimensions[longest].length) longest = index;
  });
  return longest;
}

export function fieldRequest(
  variable: Variable,
  display: DisplayDimensions,
  indices: Record<string, number>,
  viewport: { width: number; height: number },
  settled: boolean,
  region: ViewBounds = { minimumX: 0, maximumX: 1, minimumY: 0, maximumY: 1 },
): SliceRequest {
  const ranges = variable.dimensions.map((dimension, index) => {
    if (index !== display.x && index !== display.y) return undefined;
    const minimum = index === display.x ? region.minimumX : region.minimumY;
    const maximum = index === display.x ? region.maximumX : region.maximumY;
    const start = Math.max(0, Math.min(dimension.length - 1, Math.floor(minimum * dimension.length)));
    const stop = Math.max(start + 1, Math.min(dimension.length, Math.ceil(maximum * dimension.length)));
    return { start, stop };
  });
  const fullResolutionSamples = ranges.reduce(
    (total, range) => total * (range ? range.stop - range.start : 1),
    1,
  );
  // ponytail: avoid allocating a multi-hundred-MB browser slice; add tiled
  // structured reads when datasets need full resolution beyond this ceiling.
  const requestFullResolution =
    settled && fullResolutionSamples <= MAX_FULL_RESOLUTION_SAMPLES;

  const selection: string[] = [];
  const stride: string[] = [];
  variable.dimensions.forEach((dimension, index) => {
    const range = ranges[index];
    selection.push(range
      ? range.start === 0 && range.stop === dimension.length ? ":" : `${range.start}:${range.stop}`
      : String(clampIndex(indices[dimension.path], dimension.length)));
    const pixels = index === display.x ? viewport.width : viewport.height;
    stride.push(
      range && !requestFullResolution
        ? String(previewStride(range.stop - range.start, pixels))
        : "1",
    );
  });
  return {
    dataset: variable.dataset_id,
    path: variable.path,
    selection: selection.join(","),
    stride: stride.join(","),
  };
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
    dataset: variable.dataset_id,
    path: variable.path,
    selection: selection.join(","),
    stride: variable.dimensions.map(() => "1").join(","),
  };
}

/** UGRID has no implicit LOD: range its node/edge/face dimension at stride one. */
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
