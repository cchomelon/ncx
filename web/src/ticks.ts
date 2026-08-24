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
