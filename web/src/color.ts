/**
 * Colour: the single source of truth for the viewer, and the same one the
 * project's Python figures use.
 *
 * Two rules carry everything here, both from `Style/Philosophy.md` §4:
 *
 *  1. **Hue is not ordered.** A reader cannot say that red is more than green,
 *    so a colour map has to carry order in *lightness*. Every map below is one
 *    of Crameri's Scientific colour maps: perceptually uniform, monotonic in
 *    lightness where it claims to be sequential, colour-vision-deficiency
 *    friendly, and readable in greyscale.
 *  2. **Choosing a map is a claim about the data**, not a preference. A
 *    diverging map on one-sided data invents a midpoint; a sequential map on an
 *    anomaly hides the sign; a diverging map with asymmetric limits moves zero.
 *    So the viewer picks the map from the variable's CF metadata
 *    (`defaultColormap`) and only then lets the reader override it.
 */
import { SCM, SCM_CLASS, type ScmClass, type ScmName } from "./scm.ts";
import type { ColorScale } from "./model.ts";

type Rgb = readonly [number, number, number];

export type Colormap = ScmName;

/** Reversed maps get a `_r` suffix, exactly as in the Python style. */
export type ColormapChoice = Colormap | `${Colormap}_r`;

export interface ColorRange {
  minimum: number;
  maximum: number;
}

/**
 * What the reader may pick from, grouped by the structure of data each suits.
 * The grouping is the guidance: it is the only place the UI says out loud that
 * `vik` is for signed data and `batlow` is not.
 */
export const COLORMAP_GROUPS: ReadonlyArray<{
  label: string;
  options: ReadonlyArray<{ value: ColormapChoice; label: string }>;
}> = [
  {
    label: "Sequential — one-sided",
    options: [
      { value: "batlow", label: "batlow" },
      { value: "lajolla", label: "lajolla — thermal" },
      { value: "oslo_r", label: "oslo reversed — depth" },
      { value: "bilbao_r", label: "bilbao reversed — intensity" },
      { value: "grayC", label: "grayC — neutral" },
    ],
  },
  {
    label: "Diverging — signed about zero",
    options: [
      { value: "vik", label: "vik" },
      { value: "berlin", label: "berlin — dark midpoint" },
    ],
  },
  {
    label: "Multi-sequential — split at an interface",
    options: [{ value: "oleron", label: "oleron — land and sea" }],
  },
  {
    label: "Cyclic — an angle",
    options: [{ value: "romaO", label: "romaO — phase, direction" }],
  },
];

export function colormapClass(choice: ColormapChoice): ScmClass {
  return SCM_CLASS[baseName(choice)];
}

/**
 * True when the map's midpoint means zero, so the range must be symmetric.
 * `vik` centred on 0.95 because the data ran -0.4 to 2.3 is the commonest
 * colour error in this field, and it is silent: the picture looks fine.
 */
export function needsSymmetricRange(choice: ColormapChoice): boolean {
  const kind = colormapClass(choice);
  return kind === "diverging" || kind === "multi-sequential";
}

function baseName(choice: ColormapChoice): Colormap {
  return (choice.endsWith("_r") ? choice.slice(0, -2) : choice) as Colormap;
}

function isReversed(choice: ColormapChoice): boolean {
  return choice.endsWith("_r");
}

/** Decode one 256-entry table into a flat RGB byte array, once, then keep it. */
const decoded = new Map<Colormap, Uint8Array>();

function table(name: Colormap): Uint8Array {
  let bytes = decoded.get(name);
  if (bytes) return bytes;
  const packed = SCM[name];
  bytes = new Uint8Array(256 * 3);
  for (let index = 0; index < 256; index += 1) {
    const offset = index * 6;
    bytes[index * 3] = parseInt(packed.slice(offset, offset + 2), 16);
    bytes[index * 3 + 1] = parseInt(packed.slice(offset + 2, offset + 4), 16);
    bytes[index * 3 + 2] = parseInt(packed.slice(offset + 4, offset + 6), 16);
  }
  decoded.set(name, bytes);
  return bytes;
}

/**
 * The colour at `position` in 0…1. A straight lookup, not an interpolation
 * between stops: the table already has 256 perceptually even steps, so nearest
 * is both faster and more faithful than mixing two of them in sRGB.
 */
function sample(choice: ColormapChoice, position: number): Rgb {
  const bytes = table(baseName(choice));
  const clamped = Math.max(0, Math.min(1, position));
  const index = Math.round((isReversed(choice) ? 1 - clamped : clamped) * 255) * 3;
  return [bytes[index], bytes[index + 1], bytes[index + 2]];
}

export function finiteRange(values: Float32Array, colormap: ColormapChoice): ColorRange {
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
  // Any map whose midpoint means something gets a symmetric range, so the
  // neutral tone lands on zero. Not just one map named "balance".
  if (needsSymmetricRange(colormap)) {
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
  colormap: ColormapChoice,
): Rgb | undefined {
  if (!Number.isFinite(value)) return undefined;
  const position = scalePosition(value, range, scale);
  if (position === undefined) return undefined;
  return sample(colormap, position);
}

/** RGBA bytes for the WebGL palette texture, in table order. */
export function paletteBytes(colormap: ColormapChoice): Uint8Array {
  const bytes = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    const [r, g, b] = sample(colormap, index / 255);
    bytes.set([r, g, b, 255], index * 4);
  }
  return bytes;
}

/**
 * Where `value` sits along the colour ramp, in 0…1. The colourbar places its
 * ticks with this, so the bar and the pixels always agree about a value's
 * position even under a log or symlog transform.
 */
export function colorPosition(
  value: number,
  range: ColorRange,
  scale: ColorScale,
): number | undefined {
  return Number.isFinite(value) ? scalePosition(value, range, scale) : undefined;
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

// ---------------------------------------------------------------------------
// Picking the map from the data, rather than from the reader
// ---------------------------------------------------------------------------

/**
 * CF `standard_name` fragments that identify a quantity's structure. Matched as
 * substrings against the standard name, then against the long name, then the
 * variable name -- in that order, because a standard name is a controlled
 * vocabulary and the other two are whatever somebody typed.
 *
 * Order matters within the list: the first hit wins, so "sea_water_temperature"
 * must not be caught by the anomaly rule before the thermal one, and anything
 * signed has to be tested before the quantity it is an anomaly of.
 */
const RULES: ReadonlyArray<{ match: RegExp; colormap: ColormapChoice; why: string }> = [
  // Signed about a real zero. Tested first: an anomaly of X is not X.
  {
    match: /anomaly|difference|residual|_error|bias|tendency|divergence|vorticity|_flux_correction/,
    colormap: "vik",
    why: "signed about zero",
  },
  // Angles that wrap.
  {
    match: /phase|_direction|wind_from_direction|wave_from_direction|azimuth|bearing/,
    colormap: "romaO",
    why: "an angle, so the ends must meet",
  },
  // Land and sea about a common datum: two surfaces, one interface.
  {
    match: /surface_altitude|surface_height_above|topograph|orography|geoid_height/,
    colormap: "oleron",
    why: "land and sea about a datum",
  },
  // Depth increases downward: pale shallow, dark deep.
  { match: /depth|bathymetr/, colormap: "oslo_r", why: "depth below a datum" },
  // Absolute temperature.
  { match: /temperature|_heat_content|potential_temperature/, colormap: "lajolla", why: "thermal" },
  // Unsigned intensities.
  {
    match: /stress|_dissipation|turbulent_kinetic_energy|friction_velocity/,
    colormap: "bilbao_r",
    why: "an unsigned intensity",
  },
];

/**
 * The map this variable should open with.
 *
 * A viewer that opens every field in the same ramp teaches the reader nothing
 * and gets the signed ones wrong. This reads the CF metadata the file already
 * carries and applies the same context-to-map table the Python style uses
 * (`palette.FIELD`). Falls back to `batlow`, the default sequential, and to
 * `vik` for anything whose values straddle zero -- because data with both signs
 * usually has a meaningful zero even when nobody said so in an attribute.
 */
export function defaultColormap(
  hints: {
    standardName?: string;
    longName?: string;
    name?: string;
    units?: string;
  },
  range?: ColorRange,
): ColormapChoice {
  const haystacks = [hints.standardName, hints.longName, hints.name]
    .filter((text): text is string => Boolean(text))
    .map((text) => text.toLowerCase());
  for (const haystack of haystacks) {
    for (const rule of RULES) {
      if (rule.match.test(haystack)) return rule.colormap;
    }
  }
  // Degrees that are not a temperature are almost always a direction.
  if (hints.units && /^degree(s)?(_true|_north|_east)?$/i.test(hints.units.trim())) {
    return "romaO";
  }
  if (range && range.minimum < 0 && range.maximum > 0) return "vik";
  return "batlow";
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "missing";
  const magnitude = Math.abs(value);
  if ((magnitude > 0 && magnitude < 0.001) || magnitude >= 100_000) {
    return value.toExponential(3);
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: magnitude < 10 ? 3 : 2 });
}
