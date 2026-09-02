import { useEffect, useMemo, useState, type PointerEvent } from "react";

import { fetchCoordinate, fetchSlice } from "./api";
import { formatNumber } from "./color";
import {
  findComparisonSeries,
  locationIdentity,
  requestHostComparison,
  verticalDatum,
} from "./comparison";
import type { ComparisonSeries, DataSlice, Metadata, Probe, Variable } from "./model";
import { attributeText, displayUnit, quantityLabel, variableLabel } from "./model";
import { curveRequest } from "./selection";
import { axisTicks, tickCountForLength } from "./ticks";
import {
  describeTime,
  formatTimestamp,
  timeInZone,
  timeTickLabel,
  type DisplayTimeZone,
  type TimeDescription,
  type TimeTickLabel,
} from "./time";
import { useElementSize } from "./useElementSize";
import { DEFAULT_TYPE, TICK, axisOffsets, plotMargin, plotType, widestLabel, type PlotType } from "./plotgeom";

/** A multi-day time axis stacks the time under the date, so reserve two label rows. */
function curveMargin(type: PlotType) {
  return plotMargin(type, { colorbar: 28, top: Math.round(type.axis * 1.25), xRows: 2 });
}
const MODEL_COLOR = "var(--ink)";
const REFERENCE_COLOR = "#B58E30";
const REFERENCE_DASH = "7 3";

interface CurveViewProps {
  metadata: Metadata;
  variable: Variable;
  curveDimension: number;
  indices: Record<string, number>;
  average?: Probe["average"];
  timeZone: DisplayTimeZone;
  comparisonGeneration?: number;
  onFrameLoaded: () => void;
  onStatus: (status: string) => void;
}

interface Hover {
  lineX: number;
  markerX: number;
  markerY: number;
  tooltipX: number;
  tooltipY: number;
  index: number;
  x: number;
  value: number;
  reference?: {
    index: number;
    markerX: number;
    markerY: number;
    x: number;
    value: number;
  };
}

export function CurveView(props: CurveViewProps) {
  const [frame, size] = useElementSize<HTMLDivElement>();
  const [slice, setSlice] = useState<DataSlice>();
  const [xValues, setXValues] = useState<Float32Array>();
  const [hover, setHover] = useState<Hover>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [xOffsetMinutes, setXOffsetMinutes] = useState(0);
  const [yOffset, setYOffset] = useState(0);
  const [comparison, setComparison] = useState<ComparisonSeries>();
  const [comparisonError, setComparisonError] = useState<string>();
  const requests = useMemo(
    () => !props.average?.indices.length ||
      props.variable.dimensions[props.curveDimension]?.path === props.average.dimension
      ? [curveRequest(props.variable, props.curveDimension, props.indices)]
      : props.average.indices.map((index) => curveRequest(props.variable, props.curveDimension, {
          ...props.indices,
          [props.average!.dimension]: index,
        })),
    [props.variable, props.curveDimension, props.indices, props.average],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.all(requests.map((request) => fetchSlice(request, controller.signal)))
      .then((slices) => {
        if (controller.signal.aborted) return;
        const nextSlice = slices.length === 1 ? slices[0] : {
          ...slices[0],
          values: Float32Array.from(slices[0].values, (_, index) => {
            const values = slices.map((slice) => Number(slice.values[index])).filter(Number.isFinite);
            return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
          }),
        };
        setSlice(nextSlice);
        setLoading(false);
        setError(undefined);
        props.onFrameLoaded();
        props.onStatus(`${nextSlice.shape.join(" × ") || "scalar"} · curve · ${nextSlice.dtype}`);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const nextError = cause instanceof Error ? cause : new Error(String(cause));
        setLoading(false);
        setError(nextError.message);
        props.onStatus(nextError.message);
      });
    return () => controller.abort();
  }, [requests, props.onFrameLoaded, props.onStatus]);

  const dimension = props.variable.dimensions[props.curveDimension];
  const coordinate = props.metadata.variables.find(
    (variable) =>
      variable.path === dimension?.path &&
      variable.dimensions.length === 1 &&
      variable.dimensions[0].path === dimension.path,
  );
  useEffect(() => {
    let active = true;
    if (!coordinate) {
      setXValues(undefined);
      return;
    }
    fetchCoordinate(coordinate)
      .then((values) => {
        if (active) setXValues(values);
      })
      .catch(() => {
        if (active) setXValues(undefined);
      });
    return () => {
      active = false;
    };
  }, [coordinate]);

  const time = useMemo(
    () => timeInZone(describeTime(coordinate), props.timeZone),
    [coordinate, props.timeZone],
  );
  const locationId = locationIdentity(props.variable);
  const quantity = attributeText(props.variable, "standard_name")?.trim();
  const units = attributeText(props.variable, "units")?.trim();
  const modelDatum = verticalDatum(props.variable);
  const comparisonExtent = useMemo(() => {
    if (!time || !xValues?.length) return undefined;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const value of xValues) if (Number.isFinite(value)) {
      const milliseconds = time.originMs + value * time.multiplierMs;
      minimum = Math.min(minimum, milliseconds);
      maximum = Math.max(maximum, milliseconds);
    }
    return Number.isFinite(minimum) && maximum > minimum
      ? [Math.ceil(minimum), Math.floor(maximum)] as const
      : undefined;
  }, [time, xValues]);

  useEffect(() => {
    if (
      props.comparisonGeneration === undefined
      || !locationId
      || !quantity
      || !units
      || !comparisonExtent
    ) {
      setComparison(undefined);
      setComparisonError(undefined);
      return;
    }
    let active = true;
    setComparison(undefined);
    setComparisonError(undefined);
    void requestHostComparison({
      generation: props.comparisonGeneration,
      location_id: locationId,
      quantity,
      units,
      start_ms: comparisonExtent[0],
      end_ms: comparisonExtent[1],
    })
      .then((series) => {
        if (!active) return;
        const reference = findComparisonSeries(series, locationId, quantity, units);
        if (!reference) throw new Error(`No comparison matches ${locationId} ${quantity} [${units}]`);
        setComparison(reference);
      })
      .catch((cause: unknown) => {
        if (active) setComparisonError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [comparisonExtent, locationId, props.comparisonGeneration, quantity, units]);

  const displayedX = useMemo(
    () => time && xValues && xOffsetMinutes
      ? Float64Array.from(
          xValues,
          (value) => value + xOffsetMinutes * 60_000 / time.multiplierMs,
        )
      : xValues,
    [time, xValues, xOffsetMinutes],
  );
  const displayedValues = useMemo(
    () => time && yOffset && slice?.values instanceof Float32Array
      ? Float32Array.from(slice.values, (value) => value + yOffset)
      : slice?.values instanceof Float32Array ? slice.values : undefined,
    [slice, time, yOffset],
  );
  const comparisonX = useMemo(
    () => comparison && time
      ? Float64Array.from(comparison.x, (value) =>
          (value - time.originMs) / time.multiplierMs)
      : undefined,
    [comparison, time],
  );
  const comparisonValues = useMemo(
    () => comparison
      ? Float32Array.from(comparison.y)
      : undefined,
    [comparison],
  );
  const domain = useMemo(
    () => displayedValues && displayedX && comparisonValues && comparisonX
      ? sharedCurveDomain([
          { x: displayedX, y: displayedValues },
          { x: comparisonX, y: comparisonValues },
        ])
      : undefined,
    [comparisonValues, comparisonX, displayedValues, displayedX],
  );

  const geometry = useMemo(
    () => curveGeometry(
      displayedValues,
      displayedX,
      size.width,
      size.height,
      domain,
      plotType(frame.current),
    ),
    [displayedValues, displayedX, domain, size],
  );
  const comparisonGeometry = useMemo(
    () => curveGeometry(
      comparisonValues,
      comparisonX,
      size.width,
      size.height,
      domain,
      plotType(frame.current),
    ),
    [comparisonValues, comparisonX, domain, size],
  );

  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (!geometry) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = Math.max(
      geometry.plot.left,
      Math.min(geometry.plot.left + geometry.plot.width, event.clientX - bounds.left),
    );
    const fraction = (pointerX - geometry.plot.left) / geometry.plot.width;
    const targetX = geometry.xMinimum + fraction * (geometry.xMaximum - geometry.xMinimum);
    const index = nearestXIndex(geometry.xValues, targetX);
    const value = geometry.values[index];
    if (!Number.isFinite(value)) {
      setHover(undefined);
      return;
    }
    const markerX = geometry.xFor(index);
    const markerY = geometry.yFor(value);
    let reference: Hover["reference"];
    if (comparisonGeometry) {
      const referenceIndex = nearestXIndex(comparisonGeometry.xValues, targetX);
      const referenceValue = comparisonGeometry.values[referenceIndex];
      if (Number.isFinite(referenceValue)) {
        reference = {
          index: referenceIndex,
          markerX: comparisonGeometry.xFor(referenceIndex),
          markerY: comparisonGeometry.yFor(referenceValue),
          x: comparisonGeometry.xValues[referenceIndex],
          value: referenceValue,
        };
      }
    }
    setHover({
      lineX: pointerX,
      markerX,
      markerY,
      tooltipX: Math.min(size.width - 220, pointerX + 14),
      tooltipY: Math.max(8, markerY - 48),
      index,
      x: geometry.xValues[index],
      value,
      reference,
    });
  };

  return (
    <div className="single-curve">
      {time && (
        <div className="comparison-controls curve-offset-controls">
          <div className="series-control">
            <svg className="series-key" viewBox="0 0 18 4" aria-hidden="true">
              <line x1="0" y1="2" x2="18" y2="2" style={{ stroke: MODEL_COLOR }} />
            </svg>
            <strong>{variableLabel(props.variable)}</strong>
            <span>{modelDatum ?? "datum unspecified"}</span>
            <label>X offset [min]
              <input
                type="number"
                step="any"
                value={xOffsetMinutes}
                onChange={(event) => setXOffsetMinutes(finiteInput(event.currentTarget))}
              />
            </label>
            <label>Y offset [{displayUnit(props.variable) || "1"}]
              <input
                type="number"
                step="any"
                value={yOffset}
                onChange={(event) => setYOffset(finiteInput(event.currentTarget))}
              />
            </label>
          </div>
          {comparison && (
            <div className="series-control">
              <svg className="series-key" viewBox="0 0 18 4" aria-hidden="true">
                <line x1="0" y1="2" x2="18" y2="2" style={{
                  stroke: REFERENCE_COLOR,
                  strokeDasharray: REFERENCE_DASH,
              }} />
              </svg>
              <strong>{comparison.label}</strong>
              {comparison.primary_y_offset === undefined ? (
                <span>{comparison.vertical_datum ?? "datum unspecified"}</span>
              ) : (
                <label>
                  <input
                    type="checkbox"
                    checked={yOffset === comparison.primary_y_offset}
                    onChange={(event) => setYOffset(
                      event.currentTarget.checked ? comparison.primary_y_offset! : 0,
                    )}
                  />
                  {comparison.vertical_datum}
                </label>
              )}
            </div>
          )}
          <button
            disabled={!xOffsetMinutes && !yOffset}
            onClick={() => {
              setXOffsetMinutes(0);
              setYOffset(0);
            }}
          >
            Reset offsets
          </button>
          {comparisonError && <span className="comparison-warning">{comparisonError}</span>}
        </div>
      )}
      <div className="plot-frame curve-frame" ref={frame}>
      <svg
        className="curve-svg"
        width={size.width}
        height={size.height}
        onPointerMove={trackPointer}
        onPointerLeave={() => setHover(undefined)}
        aria-label={`${variableLabel(props.variable)} curve along ${dimension?.name ?? "dimension"}`}
      >
        {geometry && (
          <>
            <CurveAxes
              geometry={geometry}
              dimension={dimension?.name ?? "index"}
              time={time}
              timeNote={xOffsetMinutes ? "display offsets" : undefined}
              valueLabel={`${quantityLabel(props.variable)}${yOffset ? "; display offsets" : ""}`}
            />
            <path className="curve-line total" style={{ stroke: MODEL_COLOR }} d={geometry.path} />
            {comparisonGeometry && (
              <path
                className="curve-line comparison-line"
                style={{ stroke: REFERENCE_COLOR, strokeDasharray: REFERENCE_DASH }}
                d={comparisonGeometry.path}
              />
            )}
            {hover && (
              <g className="curve-tracker">
                <line
                  className="hover-crosshair"
                  x1={hover.lineX}
                  x2={hover.lineX}
                  y1={geometry.plot.top}
                  y2={geometry.plot.top + geometry.plot.height}
                />
                <circle className="hover-dot" cx={hover.markerX} cy={hover.markerY} r={5.5} />
                {hover.reference && (
                  <circle
                    className="hover-dot reference-dot"
                    cx={hover.reference.markerX}
                    cy={hover.reference.markerY}
                    r={5.5}
                    style={{ fill: REFERENCE_COLOR }}
                  />
                )}
              </g>
            )}
          </>
        )}
      </svg>
      {hover && (
        <output className="plot-tooltip curve-tooltip" style={{ left: hover.tooltipX, top: hover.tooltipY }}>
          <strong>{variableLabel(props.variable)}</strong>
          <span>
            Model: {formatNumber(hover.value)} {displayUnit(props.variable)} ·{
              ` ${formatCurveX(hover.x, hover.index, time)}`
            }
          </span>
          {hover.reference && comparison && (
            <span>
              {comparison.label}: {formatNumber(hover.reference.value)} {comparison.y_units} ·{
                ` ${formatCurveX(hover.reference.x, hover.reference.index, time)}`
              }
            </span>
          )}
        </output>
      )}
      {loading && <span className="plot-loading">reading newest curve…</span>}
      {error && <div className="plot-error">{error}</div>}
      </div>
    </div>
  );
}

export interface CurveDomain {
  xMinimum: number;
  xMaximum: number;
  yMinimum: number;
  yMaximum: number;
}

export function curveGeometry(
  values: Float32Array | undefined,
  coordinate: Float32Array | Float64Array | undefined,
  width: number,
  height: number,
  fixedDomain?: CurveDomain,
  type: PlotType = DEFAULT_TYPE,
) {
  if (!values?.length) return undefined;
  const xValues = coordinate?.length === values.length
    ? coordinate
    : Float32Array.from({ length: values.length }, (_, index) => index);
  let yMinimum = Number.POSITIVE_INFINITY;
  let yMaximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    yMinimum = Math.min(yMinimum, value);
    yMaximum = Math.max(yMaximum, value);
  }
  if (!Number.isFinite(yMinimum) || !Number.isFinite(yMaximum)) {
    yMinimum = 0;
    yMaximum = 1;
  } else if (yMinimum === yMaximum) {
    const padding = Math.abs(yMinimum) * 0.01 || 1;
    yMinimum -= padding;
    yMaximum += padding;
  }
  let xMinimum = Number.POSITIVE_INFINITY;
  let xMaximum = Number.NEGATIVE_INFINITY;
  for (const value of xValues) {
    if (!Number.isFinite(value)) continue;
    xMinimum = Math.min(xMinimum, value);
    xMaximum = Math.max(xMaximum, value);
  }
  if (!Number.isFinite(xMinimum) || !Number.isFinite(xMaximum)) return undefined;
  if (xMinimum === xMaximum) {
    xMinimum -= 0.5;
    xMaximum += 0.5;
  }
  if (fixedDomain) ({ xMinimum, xMaximum, yMinimum, yMaximum } = fixedDomain);
  const margin = curveMargin(type);
  const plot = {
    left: margin.left,
    top: margin.top,
    width: Math.max(1, width - margin.left - margin.right),
    height: Math.max(1, height - margin.top - margin.bottom),
  };
  const xFor = (index: number) =>
    plot.left + ((xValues[index] - xMinimum) / (xMaximum - xMinimum)) * plot.width;
  const yFor = (value: number) =>
    plot.top + (1 - (value - yMinimum) / (yMaximum - yMinimum)) * plot.height;
  let path = "";
  let drawing = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value) || !Number.isFinite(xValues[index])) {
      drawing = false;
      continue;
    }
    path += `${drawing ? "L" : "M"}${xFor(index).toFixed(2)} ${yFor(value).toFixed(2)}`;
    drawing = true;
  }
  return {
    values,
    xValues,
    xMinimum,
    xMaximum,
    yMinimum,
    yMaximum,
    plot,
    type,
    xFor,
    yFor,
    path,
  };
}

export type CurveGeometry = NonNullable<ReturnType<typeof curveGeometry>>;

export function sharedCurveDomain(
  series: Array<{ x: Float32Array | Float64Array; y: Float32Array }>,
): CurveDomain | undefined {
  let xMinimum = Number.POSITIVE_INFINITY;
  let xMaximum = Number.NEGATIVE_INFINITY;
  let yMinimum = Number.POSITIVE_INFINITY;
  let yMaximum = Number.NEGATIVE_INFINITY;
  for (const item of series) {
    for (const value of item.x) if (Number.isFinite(value)) {
      xMinimum = Math.min(xMinimum, value);
      xMaximum = Math.max(xMaximum, value);
    }
    for (const value of item.y) if (Number.isFinite(value)) {
      yMinimum = Math.min(yMinimum, value);
      yMaximum = Math.max(yMaximum, value);
    }
  }
  if (![xMinimum, xMaximum, yMinimum, yMaximum].every(Number.isFinite)) return undefined;
  if (xMinimum === xMaximum) { xMinimum -= 0.5; xMaximum += 0.5; }
  if (yMinimum === yMaximum) {
    const padding = Math.abs(yMinimum) * 0.01 || 1;
    yMinimum -= padding;
    yMaximum += padding;
  }
  return { xMinimum, xMaximum, yMinimum, yMaximum };
}

export function CurveAxes({
  geometry,
  dimension,
  time,
  valueLabel,
  timeNote,
}: {
  geometry: CurveGeometry;
  dimension: string;
  time: TimeDescription | undefined;
  valueLabel: string;
  timeNote?: string;
}) {
  const { plot } = geometry;
  const bottom = plot.top + plot.height;
  const type = geometry.type ?? DEFAULT_TYPE;
  // A time axis keeps evenly spaced samples so date and time rows stay legible;
  // a numeric axis snaps to round values like every other axis in the app.
  const xTicks = time
    ? [0, 0.25, 0.5, 0.75, 1].map(
        (fraction) => geometry.xMinimum + fraction * (geometry.xMaximum - geometry.xMinimum),
      )
    : axisTicks(geometry.xMinimum, geometry.xMaximum, tickCountForLength(plot.width)).values;
  const xFormat = time
    ? undefined
    : axisTicks(geometry.xMinimum, geometry.xMaximum, tickCountForLength(plot.width)).format;
  const xSpan = geometry.xMaximum - geometry.xMinimum;
  const xAt = (value: number) =>
    plot.left + (xSpan === 0 ? 0.5 : (value - geometry.xMinimum) / xSpan) * plot.width;
  const y = axisTicks(geometry.yMinimum, geometry.yMaximum, tickCountForLength(plot.height, 58));
  const ySpan = geometry.yMaximum - geometry.yMinimum;
  const yAt = (value: number) =>
    plot.top + (1 - (ySpan === 0 ? 0.5 : (value - geometry.yMinimum) / ySpan)) * plot.height;
  const offset = axisOffsets(type, widestLabel(y.values, y.format), time ? 2 : 1);
  return (
    <g
      className="plot-axis curve-axis"
      data-x-domain={`${geometry.xMinimum},${geometry.xMaximum}`}
      data-y-domain={`${geometry.yMinimum},${geometry.yMaximum}`}
    >
      {y.values.map((value) => (
        <line
          key={`grid-${value}`}
          className="gridline"
          x1={plot.left}
          x2={plot.left + plot.width}
          y1={yAt(value)}
          y2={yAt(value)}
        />
      ))}
      <path d={`M${plot.left} ${plot.top}V${bottom}H${plot.left + plot.width}`} />
      {xTicks.map((value, index) => {
        const x = xAt(value);
        const label: TimeTickLabel = time
          ? timeTickLabel(value, time, xSpan)
          : { primary: xFormat!(value) };
        return (
          <g key={`x-${time ? index : value}`}>
            <line x1={x} x2={x} y1={bottom} y2={bottom + TICK} />
            <text
              className={label.day ? "time-day" : "time-hour"}
              x={x}
              y={bottom + offset.xRow(0)}
              textAnchor="middle"
            >
              {label.primary}
            </text>
            {label.secondary && (
              <text className="time-secondary" x={x} y={bottom + offset.xRow(1)} textAnchor="middle">
                {label.secondary}
              </text>
            )}
          </g>
        );
      })}
      {y.values.map((value) => (
        <g key={`y-${value}`}>
          <line x1={plot.left - TICK} x2={plot.left} y1={yAt(value)} y2={yAt(value)} />
          <text x={plot.left - offset.yLabel} y={yAt(value)} dy="0.32em" textAnchor="end">
            {y.format(value)}
          </text>
        </g>
      ))}
      <text
        className="axis-label"
        x={plot.left + plot.width / 2}
        y={bottom + offset.xTitle}
        dy="0.32em"
        textAnchor="middle"
      >
        {time ? `Time (${time.zoneLabel}${timeNote ? `; ${timeNote}` : ""})` : dimension}
      </text>
      <text
        className="axis-label"
        transform={`translate(${plot.left - offset.yTitle} ${plot.top + plot.height / 2}) rotate(-90)`}
        dy="0.32em"
        textAnchor="middle"
      >
        {valueLabel}
      </text>
    </g>
  );
}

function nearestXIndex(values: Float32Array | Float64Array, target: number): number {
  const ascending = values[0] <= values[values.length - 1];
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] < target) === ascending) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  if (low === values.length) return values.length - 1;
  return Math.abs(values[low - 1] - target) <= Math.abs(values[low] - target) ? low - 1 : low;
}

function formatCurveX(value: number, index: number, time: TimeDescription | undefined): string {
  if (!time) return `sample ${index} · ${formatNumber(value)}`;
  return formatTimestamp(value, time);
}

function finiteInput(input: HTMLInputElement): number {
  return Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : 0;
}
