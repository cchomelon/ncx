/**
 * Plot furniture shared by the field, mesh, and curve views.
 *
 * Furniture is drawn in device pixels over the data, so hairlines and type keep
 * their weight at any window size, and it follows Style/: spines and ticks stay
 * below data weight, gridlines are y-only and faint, and every axis carries a
 * label.
 */
import { colorForValue, colorPosition, type ColorRange } from "./color";
import type { ColorScale } from "./model";
import type { ColormapChoice } from "./color";
import { axisTicks, tickCountForLength } from "./ticks";

export interface PlotBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Room the colourbar column needs: gap, bar, ticks, labels, rotated caption. */
export const COLORBAR_WIDTH = 62;

const RAMP_STOPS = 24;

function scaleFor(domain: [number, number], length: number, invert: boolean) {
  const span = domain[1] - domain[0];
  if (!Number.isFinite(span) || span === 0) {
    return () => (invert ? length : 0);
  }
  return (value: number) => {
    const fraction = (value - domain[0]) / span;
    return (invert ? 1 - fraction : fraction) * length;
  };
}

export function PlotAxes({
  plot,
  xDomain,
  yDomain,
  xLabel,
  yLabel,
  boxed = false,
  grid = false,
}: {
  plot: PlotBounds;
  xDomain: [number, number];
  yDomain: [number, number];
  xLabel: string;
  yLabel: string;
  /** Map and image panels are boxed; a time series keeps only two spines. */
  boxed?: boolean;
  /** Faint y-only gridlines, for reading a value off a curve. */
  grid?: boolean;
}) {
  const x = axisTicks(xDomain[0], xDomain[1], tickCountForLength(plot.width));
  const y = axisTicks(yDomain[0], yDomain[1], tickCountForLength(plot.height, 58));
  const xAt = scaleFor(xDomain, plot.width, false);
  const yAt = scaleFor(yDomain, plot.height, true);
  const bottom = plot.top + plot.height;
  const right = plot.left + plot.width;
  return (
    <g
      className="plot-axis"
      data-x-domain={`${xDomain[0]},${xDomain[1]}`}
      data-y-domain={`${yDomain[0]},${yDomain[1]}`}
    >
      {grid && y.values.map((value) => (
        <line
          key={`grid-${value}`}
          className="gridline"
          x1={plot.left}
          x2={right}
          y1={plot.top + yAt(value)}
          y2={plot.top + yAt(value)}
        />
      ))}
      {boxed ? (
        <rect x={plot.left} y={plot.top} width={plot.width} height={plot.height} />
      ) : (
        <path d={`M${plot.left} ${plot.top}V${bottom}H${right}`} />
      )}
      {x.values.map((value) => {
        const position = plot.left + xAt(value);
        return (
          <g key={`x-${value}`}>
            <line x1={position} x2={position} y1={bottom} y2={bottom + 5} />
            <text x={position} y={bottom + 18} textAnchor="middle">{x.format(value)}</text>
          </g>
        );
      })}
      {y.values.map((value) => {
        const position = plot.top + yAt(value);
        return (
          <g key={`y-${value}`}>
            <line x1={plot.left - 5} x2={plot.left} y1={position} y2={position} />
            <text x={plot.left - 9} y={position + 4} textAnchor="end">{y.format(value)}</text>
          </g>
        );
      })}
      <text className="axis-label" x={plot.left + plot.width / 2} y={bottom + 42} textAnchor="middle">
        {xLabel}
      </text>
      <text
        className="axis-label"
        transform={`translate(18 ${plot.top + plot.height / 2}) rotate(-90)`}
        textAnchor="middle"
      >
        {yLabel}
      </text>
    </g>
  );
}

/**
 * Colourbar in its own column beside the plot, with ticks on round numbers.
 *
 * The ramp is generated from the same palette the pixels are drawn from, so the
 * bar and the field cannot drift apart, and tick positions run through the
 * active colour transform, so a log or symlog bar does not lie about where a
 * value sits.
 */
export function Colorbar({
  plot,
  range,
  colormap,
  scale,
  label,
}: {
  plot: PlotBounds;
  range: ColorRange;
  colormap: ColormapChoice;
  scale: ColorScale;
  label: string;
}) {
  const width = 13;
  const left = plot.left + plot.width + 16;
  const gradientId = `ramp-${colormap}`;
  const ticks = axisTicks(range.minimum, range.maximum, tickCountForLength(plot.height, 52));
  return (
    <g className="colorbar-axis" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
          {Array.from({ length: RAMP_STOPS }, (_, index) => {
            const position = index / (RAMP_STOPS - 1);
            const color = colorForValue(position, { minimum: 0, maximum: 1 }, "linear", colormap)!;
            return (
              <stop
                key={position}
                offset={`${(position * 100).toFixed(2)}%`}
                stopColor={`rgb(${color[0]} ${color[1]} ${color[2]})`}
              />
            );
          })}
        </linearGradient>
      </defs>
      <rect x={left} y={plot.top} width={width} height={plot.height} fill={`url(#${gradientId})`} />
      <rect className="colorbar-frame" x={left} y={plot.top} width={width} height={plot.height} />
      {ticks.values.map((value) => {
        const position = colorPosition(value, range, scale);
        if (position === undefined) return null;
        const y = plot.top + (1 - position) * plot.height;
        return (
          <g key={value}>
            <line x1={left + width} x2={left + width + 4} y1={y} y2={y} />
            <text x={left + width + 7} y={y + 4}>{ticks.format(value)}</text>
          </g>
        );
      })}
      <text
        className="axis-label"
        transform={`translate(${left + width + 46} ${plot.top + plot.height / 2}) rotate(-90)`}
        textAnchor="middle"
      >
        {label}
      </text>
    </g>
  );
}

export function ViewControls({
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  return (
    <div className="view-controls" aria-label="Plot view controls">
      <button title="Zoom in" aria-label="Zoom in" onClick={onZoomIn}>+</button>
      <button title="Zoom out" aria-label="Zoom out" onClick={onZoomOut}>−</button>
      <button title="Reset view" onClick={onReset}>Reset</button>
    </div>
  );
}
