/**
 * Axis and colourbar ticks.
 *
 * Ticks land on 1 / 2 / 2.5 / 5 × 10ⁿ, and every label in one axis is printed
 * to the precision of the tick spacing. Dividing a domain into fixed fractions
 * instead produces labels like 18.75 and 1.094e-6: a reader cannot hold those
 * numbers, and the spurious digits suggest a precision the data does not have.
 */

/** The nearest 1 / 2 / 2.5 / 5 × 10ⁿ step at or above `raw`. */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(raw));
  const mantissa = raw / base;
  const snapped =
    mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 2.5 ? 2.5 : mantissa <= 5 ? 5 : 10;
  return snapped * base;
}

/**
 * Round tick values inside `[minimum, maximum]`, aiming for `count` of them.
 * Returns the domain endpoints when the span is degenerate, so an axis always
 * carries at least one labelled value.
 */
export function niceTicks(minimum: number, maximum: number, count = 5): number[] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [];
  if (minimum === maximum) return [minimum];
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  const step = niceStep((high - low) / Math.max(1, count));
  const tolerance = step * 1e-9;
  const ticks: number[] = [];
  for (
    let value = Math.ceil(low / step - 1e-9) * step;
    value <= high + tolerance && ticks.length <= 1000;
    value += step
  ) {
    // Snap the accumulated float error, so 0 prints as 0 rather than 3e-17.
    ticks.push(Math.abs(value) < tolerance ? 0 : value);
  }
  return ticks;
}

/** Spacing of an evenly spaced tick list, for choosing label precision. */
export function tickStep(ticks: readonly number[]): number {
  return ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
}

/**
 * Format `value` with the number of decimals `step` justifies. Falls back to
 * exponential notation only where fixed notation would be unreadable.
 */
export function formatTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return "missing";
  const magnitude = Math.abs(value);
  // Zero deliberately keeps the axis precision ("0.0" beside "0.1"), because a
  // single label formatted differently from its neighbours reads as an error.
  if (magnitude !== 0 && (magnitude >= 1e5 || (step > 0 && step < 1e-4))) {
    return trimExponential(value.toExponential(2));
  }
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  const text = value.toFixed(decimals);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

/** Ticks and their shared formatter, which is how callers normally want them. */
export function axisTicks(
  minimum: number,
  maximum: number,
  count = 5,
): { values: number[]; format: (value: number) => string } {
  const values = niceTicks(minimum, maximum, count);
  const step = tickStep(values);
  return { values, format: (value: number) => formatTick(value, step) };
}

/**
 * How many ticks fit along `pixels`, given the room one label needs. Keeps a
 * short axis from crushing its labels together and a long one from carrying a
 * label every few pixels.
 */
export function tickCountForLength(pixels: number, pixelsPerTick = 84): number {
  return Math.max(2, Math.min(11, Math.round(pixels / pixelsPerTick)));
}

function trimExponential(text: string): string {
  return text.replace(/\.?0+e/, "e").replace("e+", "e");
}

/* ---------------------------------------------------------------------------
   The two-tier ladder, ported from Style/plotstyle/helpers.py.

   design.md § Frame: "Two tick ladders: dense small ticks; labelled every 2nd,
   5th, or 10th." A single tier cannot do both jobs -- a ladder dense enough to
   read a value off is far too dense to label, and a ladder sparse enough to
   label leaves the reader interpolating across a wide gap.

   Small ticks come from the axis length alone; the labelled interval is then a
   whole multiple of the small one, chosen so the labels themselves do not
   collide. Both round onto DCL's 1/2/5 blocks, which is why the numbers a
   reader sees are always round.
   --------------------------------------------------------------------------- */

const BLOCK_125 = [1, 2, 5, 10];
const BLOCK_124 = [1, 2, 4, 10];
const BLOCK_EPS = 1e-6;

function splitMantissa(value: number): [number, number] {
  if (value === 0) return [0, 0];
  const power = Math.floor(Math.log10(Math.abs(value)));
  return [Math.abs(value) / 10 ** power, power];
}

/** Greatest block value at or below `value` (DCL GNLE). Rounds an interval down. */
export function blockLe(value: number, block = BLOCK_125): number {
  const [mantissa, power] = splitMantissa(value);
  if (mantissa === 0) return 0;
  let chosen = block[0];
  for (const candidate of block) if (candidate <= mantissa * (1 + BLOCK_EPS)) chosen = candidate;
  return chosen * 10 ** power;
}

/** Least block value at or above `value` (DCL GNGE). Rounds an interval up. */
export function blockGe(value: number, block = BLOCK_125): number {
  const [mantissa, power] = splitMantissa(value);
  if (mantissa === 0) return 0;
  for (const candidate of block) {
    if (candidate >= mantissa * (1 - BLOCK_EPS)) return candidate * 10 ** power;
  }
  return block[block.length - 1] * 10 ** power;
}

/**
 * Small-tick interval, in data units (DCL `usurdt.f`).
 *
 * Target spacing is two label heights; rounding it *down* onto 1/2/5 puts the
 * ticks between 0.4 and 1.0 of that apart, which is design.md's 15-35 small
 * ticks on a normal panel.
 */
export function minorInterval(
  minimum: number,
  maximum: number,
  length: number,
  labelHeight: number,
): number {
  const span = maximum - minimum;
  if (length <= 0 || span === 0 || !Number.isFinite(span)) return 1;
  return blockLe(Math.abs((span / length) * labelHeight * 2));
}

/** Characters in the widest label at `step`, standing in for DCL's USZDGT. */
function labelWidth(minimum: number, maximum: number, step: number, maxDigits: number): number {
  const decimals = Math.min(
    Math.max(0, -Math.floor(Math.log10(Math.abs(step)) + BLOCK_EPS)),
    Math.max(0, maxDigits - 1),
  );
  const width = Math.max(
    minimum.toFixed(decimals).length,
    maximum.toFixed(decimals).length,
  );
  return Math.max(1, Math.min(width, maxDigits + 2));
}

/**
 * Labelled-tick interval, in data units (DCL `ususcu.f`).
 *
 * Always a whole multiple of `step`, minimum 2: a DCL axis never labels every
 * small tick. `across` is true for a y axis, whose labels stack sideways and
 * need a two-character gap rather than one.
 */
export function labelInterval(
  minimum: number,
  maximum: number,
  length: number,
  labelHeight: number,
  step: number,
  { across = false, maxDigits = 4 }: { across?: boolean; maxDigits?: number } = {},
): number {
  const span = Math.abs(maximum - minimum);
  if (span === 0 || step <= 0 || length <= 0) return Math.max(step, 1) * 2;
  const perUnit = length / span;
  const gap = across ? 2 : 1;
  const block = Math.abs(splitMantissa(step)[0] - 5) < BLOCK_EPS ? BLOCK_124 : BLOCK_125;
  let floor = step * 2;
  let out = floor;
  for (let pass = 0; pass < 2; pass += 1) {
    const digits = across ? 1 : labelWidth(minimum, maximum, floor, maxDigits);
    const factor = blockGe((labelHeight * (digits + gap)) / (perUnit * step), block);
    const whole = Math.trunc(Math.max(factor, 2) + 0.1);
    out = Math.max(step * whole, floor);
    if (whole < 10) break;
    floor = out / 2;
  }
  // DCL sizes labels against a full-page viewport; in a narrow panel the same
  // arithmetic can leave one label on the axis, or none.
  while (out > step * 2 && span / out < 2) out = Math.max(step * 2, out / 2);
  return out;
}

/** Every multiple of `step` inside the domain, endpoints included. */
function multiplesWithin(minimum: number, maximum: number, step: number): number[] {
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const tolerance = step * 1e-9;
  const values: number[] = [];
  for (
    let value = Math.ceil(minimum / step - 1e-9) * step;
    value <= maximum + tolerance && values.length <= 4000;
    value += step
  ) {
    values.push(Math.abs(value) < tolerance ? 0 : value);
  }
  return values;
}

/** A domain grown outward onto whole small ticks (design.md § Frame). */
export function limitsOnTick(
  minimum: number,
  maximum: number,
  step: number,
): [number, number] {
  if (!(step > 0) || !Number.isFinite(step)) return [minimum, maximum];
  return [
    Math.floor(minimum / step + 1e-9) * step,
    Math.ceil(maximum / step - 1e-9) * step,
  ];
}

export interface TickLadder {
  /** Every small tick. Unlabelled; drawn at half length. */
  minor: number[];
  /** The labelled subset. Drawn at full length. */
  major: number[];
  /** Small-tick interval, for rounding limits onto a tick. */
  step: number;
  format: (value: number) => string;
}

/**
 * The dense small ladder and its labelled subset for one axis.
 *
 * `length` is the axis length in px and `labelHeight` the tick type size, so
 * the whole ladder follows the type the way every other distance in the figure
 * does.
 */
export function tickLadder(
  minimum: number,
  maximum: number,
  length: number,
  labelHeight: number,
  { across = false }: { across?: boolean } = {},
): TickLadder {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low === high) {
    return { minor: [], major: low === high ? [low] : [], step: 1, format: (v) => formatTick(v, 1) };
  }
  const step = minorInterval(low, high, length, labelHeight);
  const labelStep = labelInterval(low, high, length, labelHeight, step, { across });
  const major = multiplesWithin(low, high, labelStep);
  const majorSet = new Set(major.map((value) => Math.round(value / step)));
  const minor = multiplesWithin(low, high, step).filter(
    (value) => !majorSet.has(Math.round(value / step)),
  );
  return { minor, major, step, format: (value: number) => formatTick(value, labelStep) };
}
