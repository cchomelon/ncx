import type { Colormap, ColorScale } from "./model";

type Rgb = readonly [number, number, number];
type ColorStop = readonly [number, Rgb];

const PALETTES: Record<Colormap, readonly ColorStop[]> = {
  viridis: [
    [0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 145, 140]],
    [0.75, [94, 201, 98]],
    [1, [253, 231, 37]],
  ],
  thermal: [
    [0, [12, 20, 70]],
    [0.28, [81, 32, 126]],
    [0.55, [188, 55, 84]],
    [0.78, [239, 131, 60]],
    [1, [252, 244, 171]],
  ],
  balance: [
    [0, [31, 81, 132]],
    [0.25, [98, 158, 196]],
    [0.5, [245, 244, 240]],
    [0.75, [214, 131, 104]],
    [1, [139, 46, 44]],
  ],
  grayscale: [
    [0, [24, 27, 30]],
    [1, [245, 245, 242]],
  ],
};

export interface ColorRange {
  minimum: number;
  maximum: number;
}

export function finiteRange(values: Float32Array, colormap: Colormap): ColorRange {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    return { minimum: 0, maximum: 1 };
  }
  if (colormap === "balance") {
    const magnitude = Math.max(Math.abs(minimum), Math.abs(maximum)) || 1;
    return { minimum: -magnitude, maximum: magnitude };
  }
  if (minimum === maximum) {
    const padding = Math.abs(minimum) * 0.01 || 1;
    return { minimum: minimum - padding, maximum: maximum + padding };
  }
  return { minimum, maximum };
}

export function colorForValue(
  value: number,
  range: ColorRange,
  scale: ColorScale,
  colormap: Colormap,
): Rgb | undefined {
  if (!Number.isFinite(value)) return undefined;
  const position = scalePosition(value, range, scale);
  if (position === undefined) return undefined;
  const stops = PALETTES[colormap];
  const upperIndex = stops.findIndex(([stop]) => stop >= position);
  if (upperIndex <= 0) return stops[0][1];
  if (upperIndex < 0) return stops[stops.length - 1][1];
  const [lowerStop, lower] = stops[upperIndex - 1];
  const [upperStop, upper] = stops[upperIndex];
  const mix = (position - lowerStop) / (upperStop - lowerStop);
  return [
    Math.round(lower[0] + (upper[0] - lower[0]) * mix),
    Math.round(lower[1] + (upper[1] - lower[1]) * mix),
    Math.round(lower[2] + (upper[2] - lower[2]) * mix),
  ];
}

export function paletteBytes(colormap: Colormap): Uint8Array {
  const bytes = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    const color = colorForValue(index / 255, { minimum: 0, maximum: 1 }, "linear", colormap)!;
    bytes.set([color[0], color[1], color[2], 255], index * 4);
  }
  return bytes;
}

function scalePosition(
  value: number,
  range: ColorRange,
  scale: ColorScale,
): number | undefined {
  let minimum = range.minimum;
  let maximum = range.maximum;
  if (scale === "log") {
    if (value <= 0 || maximum <= 0) return undefined;
    minimum = Math.log(Math.max(minimum, Number.MIN_VALUE));
    maximum = Math.log(maximum);
    value = Math.log(value);
  } else if (scale === "symlog") {
    const threshold = Math.max(Math.abs(minimum), Math.abs(maximum)) * 0.01 || 1;
    const symlog = (number: number) => Math.sign(number) * Math.log1p(Math.abs(number) / threshold);
    minimum = symlog(minimum);
    maximum = symlog(maximum);
    value = symlog(value);
  }
  return Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum || 1)));
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "missing";
  const magnitude = Math.abs(value);
  if ((magnitude > 0 && magnitude < 0.001) || magnitude >= 100_000) {
    return value.toExponential(3);
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: magnitude < 10 ? 3 : 2 });
}
