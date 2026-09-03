/**
 * Where plot furniture sits, in one place.
 *
 * Every offset around an axis used to be a literal in `plot.tsx` -- a tick at
 * `bottom + 5`, its label at `bottom + 18`, the axis title at `bottom + 42`,
 * and the y title pinned at `translate(18 ...)`. Those numbers were calibrated
 * against roughly 11px type. They are wrong at any other size, and the y title
 * was wrong at *every* size, because `fitPlotToBounds` centres the plot inside
 * the margin box to preserve the coordinate aspect ratio: `plot.left` moves,
 * and a title pinned to the SVG's own left edge does not move with it.
 *
 * So the geometry is derived from the type size instead of chosen for one, and
 * the margins, the axis renderer and the PNG export all read it from here.
 *
 * The stacking rule is DCL's (see ../../Style/Reference/Dennou.md): a row of
 * text costs PAD of its own height as a gap, then its full height, and rows
 * stack without measuring the text. That is what keeps two panels with
 * different labels lining up.
 *
 * Every length here is a multiple of the tick label height, which is DCL's own
 * arrangement one anchor along: DCL measures its ladder against the page
 * (`uzrqnp.f` gives tick 0.007, label 0.021, title 0.028 of the long side),
 * Style re-anchors the same ratios on the tick type size, and this follows
 * Style. The consequence is the one worth keeping: a figure has no absolute
 * size, so what is exported is what was on screen, larger.
 */

/**
 * Tick mark length, in units of the tick label height (Style `rc.TICK_MAJOR`).
 *
 * DCL sizes the whole axis against the page: `RSIZET2` 0.014 against `RSIZEL1`
 * 0.021, so a tick is two thirds of a label. Style re-anchored that ratio on
 * the type size and pulled it back to 0.45, because DCL's own tick runs about
 * a fifth of a tick interval and is far too loud pointing outward.
 *
 * This was a flat 5px, which is the one thing the ladder does not allow: it
 * held at 5px while the type ran from 14px to 22px, so a figure exported large
 * was not the same figure seen small. Nothing in a Dennou plot has a length of
 * its own -- the label height is the unit, and everything else is a multiple.
 */
export const TICK_MAJOR = 0.45;

/** Minor tick, keeping DCL's exact 2:1 (`RSIZET2` over `RSIZET1`). */
export const TICK_MINOR = TICK_MAJOR / 2;

/** DCL PAD1: the gap before a row of text, in units of that row's own height. */
export const PAD = 0.7;

/**
 * Gap between a tick label and the tick, in label heights (Style `rc.TICK_PAD`).
 *
 * Smaller than PAD because DCL measures PAD1 from the axis line, while these
 * ticks point outward and the gap starts past the tick.
 */
export const TICK_PAD = 0.38;

/**
 * Tick pitch, in label heights: `along` for labels reading along their axis,
 * `across` for an axis whose labels stack sideways and need only their height.
 *
 * DCL derives the interval from the label width and a one- or two-character
 * gap (`ususcu.f`, NBLANK1/NBLANK2). These two constants stand in for that
 * measurement, and hold the pitch the panels already had at 14px type -- the
 * point of naming them is that the pitch now rides the type size instead of
 * being a pixel count that silently crowds the labels as the type grows.
 *
 * `time` is DCL's own TFACT of 2 (`usurdt.f`), which the clock axis can afford
 * because its labels are two digits rather than a formatted number.
 */
export const PITCH = { along: 6, across: 4.2, time: 2 };

/** Tick length for a given type size. */
export function tickLength(type: PlotType, minor = false): number {
  return type.tick * (minor ? TICK_MINOR : TICK_MAJOR);
}

/**
 * Character advance of the plot face, in units of the font size.
 *
 * AVHershey Simplex is very nearly monospaced -- Style's `tabular_formatter`
 * notes advances of 517-519 per 1000 em -- and tick labels are digits, minus
 * signs and points. So counting characters predicts the label column width
 * closely enough to reserve space for it, with no measurement pass.
 */
export const ADVANCE = 0.52;

export interface PlotType {
  /** Tick label size, px. */
  tick: number;
  /** Axis title size, px. */
  axis: number;
}

/** Fallbacks matching the CSS floors, for the first render before layout. */
export const DEFAULT_TYPE: PlotType = { tick: 14, axis: 16 };

/**
 * Read the live plot type sizes off the DOM.
 *
 * They come from container-query clamps in `style.css`, so they depend on the
 * panel's size and cannot be duplicated here without drifting. `.plot-axis`
 * carries the tick size and `.axis-label` the title size.
 */
export function plotType(root: Element | null): PlotType {
  if (!root || typeof getComputedStyle !== "function") return DEFAULT_TYPE;
  const styles = getComputedStyle(root);
  const tick = parseFloat(styles.getPropertyValue("--plot-tick-size"));
  const axis = parseFloat(styles.getPropertyValue("--plot-axis-size"));
  return {
    tick: Number.isFinite(tick) && tick > 0 ? tick : DEFAULT_TYPE.tick,
    axis: Number.isFinite(axis) && axis > 0 ? axis : DEFAULT_TYPE.axis,
  };
}

/**
 * Offsets from the plot frame to each piece of furniture, in px.
 *
 * `xLabel` and `yLabel` are the *baseline* of the tick label; `xTitle` and
 * `yTitle` the centre of the axis title. `yTitle` needs the width of the label
 * column, so it takes the longest tick label the caller is about to draw.
 */
export function axisOffsets(type: PlotType, yLabelChars = 0, xRows = 1) {
  const tick = tickLength(type);
  const labelRow = type.tick * (PAD + 1);
  const column = yLabelChars * type.tick * ADVANCE;
  return {
    /** Baseline of the nth stacked x tick label row, below the frame. A time
     *  axis stacks a month under the day; a plain one has a single row. */
    xRow: (row: number) => tick + type.tick * TICK_PAD + type.tick * 0.78 + row * labelRow,
    /** Tick label baseline below the frame. Half the cap height re-centres it. */
    xLabel: tick + type.tick * TICK_PAD + type.tick * 0.78,
    /** Tick label baseline left of the frame; the text is end-anchored. */
    yLabel: tick + type.tick * TICK_PAD,
    /** Axis title centre, below the frame, clear of the label row. */
    xTitle: tick + labelRow * xRows + type.axis * (PAD + 0.5),
    /** Axis title centre, left of the frame, clear of the label column. */
    yTitle: tick + type.tick * TICK_PAD + column + type.axis * (PAD + 0.5),
  };
}

/**
 * The margin a panel must reserve for its furniture.
 *
 * `yLabelChars` is the longest y tick label expected; four digits and a sign
 * covers latitudes, depths and most CF coordinates, and the axis falls back to
 * it before the first layout arrives.
 */
export function plotMargin(
  type: PlotType,
  options: { colorbar?: number; yLabelChars?: number; top?: number; xRows?: number } = {},
) {
  const offsets = axisOffsets(type, options.yLabelChars ?? 5, options.xRows ?? 1);
  return {
    top: options.top ?? Math.round(type.axis * 1.6),
    right: options.colorbar ?? 14,
    bottom: Math.round(offsets.xTitle + type.axis * 0.7),
    left: Math.round(offsets.yTitle + type.axis * 0.7),
  };
}

/**
 * Characters of tick label the colourbar column reserves.
 *
 * The margin has to be sized before the ticks exist -- the tick count depends
 * on the plot height, which depends on the margin -- so the reservation is a
 * generous constant rather than a measurement. Six covers `-8e5`, `1013.2` and
 * `-0.005`; a wider label pushes its caption a few px into the right margin
 * rather than colliding with it.
 */
export const COLORBAR_CHARS = 6;

/**
 * Colourbar geometry, as offsets from the right edge of the plot frame.
 *
 * The caption used to sit at a flat `+46px`, which was clear of a three-digit
 * tick label at 11px type and buried under `-8e5` at 19px. It is derived now,
 * like every other label, from the type size and the width of the column it
 * has to clear.
 */
export function colorbarGeometry(type: PlotType, tickChars = COLORBAR_CHARS) {
  const bar = Math.max(10, Math.round(type.tick * 0.7));
  const gap = Math.round(type.tick * 0.9);
  const mark = Math.round(tickLength(type) * 0.8);
  const labelX = gap + bar + mark + type.tick * TICK_PAD;
  const column = Math.max(tickChars, COLORBAR_CHARS) * type.tick * ADVANCE;
  const captionX = labelX + column + type.axis * (PAD + 0.5);
  return {
    /** Bar width, and its left edge relative to the plot's right edge. */
    bar, gap, mark, labelX, captionX,
    /** Room the whole column needs, for the panel margin. */
    total: Math.round(captionX + type.axis * 0.7),
  };
}

/** Longest formatted tick label in a set, in characters. */
export function widestLabel(values: number[], format: (value: number) => string): number {
  let widest = 0;
  for (const value of values) widest = Math.max(widest, format(value).length);
  return widest;
}
