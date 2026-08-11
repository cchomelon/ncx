import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { LatestSliceLoader, fetchCoordinate } from "./api";
import { formatNumber } from "./color";
import type { DataSlice, Metadata, Variable } from "./model";
import { variableLabel, variableUnit } from "./model";
import { curveRequest } from "./selection";
import {
  describeTime,
  formatTimestamp,
  timeTickLabel,
  type TimeDescription,
  type TimeTickLabel,
} from "./time";
import { useElementSize } from "./useElementSize";

const MARGIN = { top: 20, right: 28, bottom: 68, left: 70 };

interface CurveViewProps {
  metadata: Metadata;
  variable: Variable;
  curveDimension: number;
  indices: Record<string, number>;
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
}

export function CurveView(props: CurveViewProps) {
  const [frame, size] = useElementSize<HTMLDivElement>();
  const loader = useRef<LatestSliceLoader>(new LatestSliceLoader());
  const [slice, setSlice] = useState<DataSlice>();
  const [xValues, setXValues] = useState<Float32Array>();
  const [hover, setHover] = useState<Hover>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const request = useMemo(
    () => curveRequest(props.variable, props.curveDimension, props.indices),
    [props.variable, props.curveDimension, props.indices],
  );

  useEffect(() => () => loader.current.dispose(), []);

  useEffect(() => {
    setLoading(true);
    loader.current.request({
      request,
      accept: (nextSlice) => {
        setSlice(nextSlice);
        setLoading(false);
        setError(undefined);
        props.onFrameLoaded();
        props.onStatus(`${nextSlice.shape.join(" × ") || "scalar"} · curve · ${nextSlice.dtype}`);
      },
      reject: (nextError) => {
        setLoading(false);
        setError(nextError.message);
        props.onStatus(nextError.message);
      },
    });
  }, [request, props.onFrameLoaded, props.onStatus]);

  const dimension = props.variable.dimensions[props.curveDimension];
  useEffect(() => {
    let active = true;
    const coordinate = props.metadata.variables.find(
      (variable) =>
        variable.path === dimension?.path &&
        variable.dimensions.length === 1 &&
        variable.dimensions[0].path === dimension.path,
    );
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
  }, [props.metadata.variables, dimension]);

  const geometry = useMemo(
    () => curveGeometry(slice, xValues, size.width, size.height),
    [slice, xValues, size],
  );
  const time = describeTime(
    props.metadata.variables.find((variable) => variable.path === dimension?.path),
  );

  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (!geometry) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = Math.max(
      geometry.plot.left,
      Math.min(geometry.plot.left + geometry.plot.width, event.clientX - bounds.left),
    );
    const fraction = (pointerX - geometry.plot.left) / geometry.plot.width;
    const index = Math.max(0, Math.min(geometry.values.length - 1, Math.round(fraction * (geometry.values.length - 1))));
    const value = geometry.values[index];
    if (!Number.isFinite(value)) {
      setHover(undefined);
      return;
    }
    const markerX = geometry.xFor(index);
    const markerY = geometry.yFor(value);
    setHover({
      lineX: pointerX,
      markerX,
      markerY,
      tooltipX: Math.min(size.width - 220, pointerX + 14),
      tooltipY: Math.max(8, markerY - 48),
      index,
      x: geometry.xValues[index],
      value,
    });
  };

  return (
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
            <CurveAxes geometry={geometry} dimension={dimension?.name ?? "index"} time={time} />
            <path className="curve-line total" d={geometry.path} />
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
              </g>
            )}
          </>
        )}
      </svg>
      {hover && (
        <output className="plot-tooltip curve-tooltip" style={{ left: hover.tooltipX, top: hover.tooltipY }}>
          <strong>{variableLabel(props.variable)}</strong>
          <span>{formatNumber(hover.value)} {variableUnit(props.variable)}</span>
          <span>{formatCurveX(hover.x, hover.index, time)}</span>
        </output>
      )}
      {loading && <span className="plot-loading">reading newest curve…</span>}
      {error && <div className="plot-error">{error}</div>}
    </div>
  );
}

function curveGeometry(
  slice: DataSlice | undefined,
  coordinate: Float32Array | undefined,
  width: number,
  height: number,
) {
  if (!slice || !(slice.values instanceof Float32Array) || slice.values.length < 1) {
    return undefined;
  }
  const values = slice.values;
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
  const xMinimum = Number(xValues[0]);
  const xMaximum = Number(xValues.at(-1));
  const plot = {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(1, width - MARGIN.left - MARGIN.right),
    height: Math.max(1, height - MARGIN.top - MARGIN.bottom),
  };
  const xFor = (index: number) =>
    plot.left + (index / Math.max(1, values.length - 1)) * plot.width;
  const yFor = (value: number) =>
    plot.top + (1 - (value - yMinimum) / (yMaximum - yMinimum)) * plot.height;
  let path = "";
  let drawing = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
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
    xFor,
    yFor,
    path,
  };
}

type CurveGeometry = NonNullable<ReturnType<typeof curveGeometry>>;

function CurveAxes({
  geometry,
  dimension,
  time,
}: {
  geometry: CurveGeometry;
  dimension: string;
  time: TimeDescription | undefined;
}) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const { plot } = geometry;
  return (
    <g className="plot-axis curve-axis">
      <path d={`M${plot.left} ${plot.top}V${plot.top + plot.height}H${plot.left + plot.width}`} />
      {ticks.map((fraction) => {
        const x = plot.left + fraction * plot.width;
        const value = geometry.xMinimum + fraction * (geometry.xMaximum - geometry.xMinimum);
        const label: TimeTickLabel = time
          ? timeTickLabel(value, time)
          : { primary: formatNumber(value) };
        return (
          <g key={`x-${fraction}`}>
            <line x1={x} x2={x} y1={plot.top + plot.height} y2={plot.top + plot.height + 6} />
            <text
              className={label.day ? "time-day" : "time-hour"}
              x={x}
              y={plot.top + plot.height + (label.day ? 24 : 17)}
              textAnchor="middle"
            >
              {label.primary}
            </text>
            {label.month && (
              <text className="time-month" x={x} y={plot.top + plot.height + 39} textAnchor="middle">
                {label.month}
              </text>
            )}
          </g>
        );
      })}
      {ticks.map((fraction) => {
        const y = plot.top + (1 - fraction) * plot.height;
        const value = geometry.yMinimum + fraction * (geometry.yMaximum - geometry.yMinimum);
        return (
          <g key={`y-${fraction}`}>
            <line x1={plot.left - 5} x2={plot.left} y1={y} y2={y} />
            <text x={plot.left - 9} y={y + 4} textAnchor="end">{formatNumber(value)}</text>
          </g>
        );
      })}
      <text className="axis-label" x={plot.left + plot.width / 2} y={plot.top + plot.height + 57} textAnchor="middle">
        {time ? `Time (${time.zoneLabel})` : dimension}
      </text>
    </g>
  );
}

function formatCurveX(value: number, index: number, time: TimeDescription | undefined): string {
  if (!time) return `sample ${index} · ${formatNumber(value)}`;
  return formatTimestamp(value, time);
}
