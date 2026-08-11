import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { LatestSliceLoader, fetchCoordinate } from "./api";
import { colorForValue, finiteRange, formatNumber, type ColorRange } from "./color";
import type {
  Colormap,
  ColorScale,
  DataSlice,
  Metadata,
  Probe,
  Variable,
} from "./model";
import { attributeText, variableUnit } from "./model";
import { formatPosition, probeAtPosition } from "./projection";
import { fieldRequest, type DisplayDimensions } from "./selection";
import { useElementSize } from "./useElementSize";
import { MapOverlay } from "./MapOverlay";
import {
  aspectRectangle,
  boxZoomBounds,
  fitPlotToBounds,
  panBounds,
  zoomBounds,
  type ViewBounds,
  type ViewRectangle,
} from "./view";

const MARGIN = { top: 18, right: 30, bottom: 52, left: 68 };

interface FieldViewProps {
  metadata: Metadata;
  variable: Variable;
  display: DisplayDimensions;
  indices: Record<string, number>;
  settled: boolean;
  colormap: Colormap;
  scale: ColorScale;
  range: ColorRange;
  rangeLocked: boolean;
  mapSource: "none" | "osm";
  probe: Probe | undefined;
  initialView?: ViewBounds;
  onViewChange: (view: ViewBounds) => void;
  onProbe: (probe: Probe) => void;
  onRange: (range: ColorRange) => void;
  onFrameLoaded: () => void;
  onStatus: (status: string) => void;
}

interface Coordinates {
  x?: Float32Array;
  y?: Float32Array;
}

interface HoverValue {
  left: number;
  top: number;
  x: number;
  y: number;
  value: number;
  sourceX: number;
  sourceY: number;
}

interface FieldDrag {
  mode: "zoom" | "pan";
  start: { x: number; y: number };
  view: ViewBounds;
}

const FULL_FIELD: ViewBounds = { minimumX: 0, maximumX: 1, minimumY: 0, maximumY: 1 };

export function FieldView(props: FieldViewProps) {
  const [frame, frameSize] = useElementSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const loader = useRef<LatestSliceLoader>(new LatestSliceLoader());
  const [slice, setSlice] = useState<DataSlice>();
  const [coordinates, setCoordinates] = useState<Coordinates>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [hover, setHover] = useState<HoverValue>();
  const [view, setView] = useState<ViewBounds>(props.initialView ?? FULL_FIELD);
  const [dragBox, setDragBox] = useState<ViewRectangle>();
  const drag = useRef<FieldDrag | undefined>(undefined);
  const changeView = (nextView: ViewBounds) => {
    setView(nextView);
    props.onViewChange(nextView);
  };

  const availablePlot = {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(1, frameSize.width - MARGIN.left - MARGIN.right),
    height: Math.max(1, frameSize.height - MARGIN.top - MARGIN.bottom),
  };
  const request = useMemo(
    () =>
      fieldRequest(
        props.variable,
        props.display,
        props.indices,
        { width: availablePlot.width, height: availablePlot.height },
        props.settled,
      ),
    [
      props.variable,
      props.display,
      props.indices,
      props.settled,
      availablePlot.width,
      availablePlot.height,
    ],
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
        props.onStatus(
          `${nextSlice.shape.join(" × ") || "scalar"} · stride ${request.stride} · ${nextSlice.dtype}`,
        );
      },
      reject: (nextError) => {
        setLoading(false);
        setError(nextError.message);
        props.onStatus(nextError.message);
      },
    });
  }, [request.path, request.selection, request.stride, props.onFrameLoaded, props.onStatus]);

  useEffect(() => {
    let active = true;
    const hint = props.variable.view_hint;
    if (hint.kind !== "rectilinear") {
      setCoordinates({});
      return;
    }
    const x = props.metadata.variables.find(
      (variable) => variable.path === hint.x,
    );
    const y = props.metadata.variables.find(
      (variable) => variable.path === hint.y,
    );
    if (!x || !y) return;
    Promise.all([fetchCoordinate(x), fetchCoordinate(y)])
      .then(([xValues, yValues]) => {
        if (active) setCoordinates({ x: xValues, y: yValues });
      })
      .catch(() => {
        if (active) setCoordinates({});
      });
    return () => {
      active = false;
    };
  }, [props.metadata.variables, props.variable]);

  const layout = useMemo(
    () => fieldLayout(props.variable, props.display, slice, coordinates),
    [props.variable, props.display, slice, coordinates],
  );
  const plot = layout
    ? fitPlotToBounds(availablePlot, {
        minimumX: layout.xDomain[0],
        maximumX: layout.xDomain[1],
        minimumY: layout.yDomain[0],
        maximumY: layout.yDomain[1],
      })
    : availablePlot;

  useEffect(() => {
    const node = canvas.current;
    if (!node || !slice || !layout || !(slice.values instanceof Float32Array)) return;
    const automaticRange = finiteRange(slice.values, props.colormap);
    const nextRange = props.rangeLocked ? props.range : automaticRange;
    const visible = fieldWindow(layout, view);
    if (
      !props.rangeLocked &&
      (automaticRange.minimum !== props.range.minimum || automaticRange.maximum !== props.range.maximum)
    ) {
      props.onRange(automaticRange);
    }
    node.width = visible.columns;
    node.height = visible.rows;
    const context = node.getContext("2d", { alpha: false });
    if (!context) return;
    const image = context.createImageData(visible.columns, visible.rows);
    for (let targetRow = 0; targetRow < visible.rows; targetRow += 1) {
      for (let targetColumn = 0; targetColumn < visible.columns; targetColumn += 1) {
        const displayRow = visible.firstRow + targetRow;
        const displayColumn = visible.firstColumn + targetColumn;
        const row = layout.flipY ? layout.rows - 1 - displayRow : displayRow;
        const column = layout.flipX ? layout.columns - 1 - displayColumn : displayColumn;
        const target = (targetRow * visible.columns + targetColumn) * 4;
        const color = colorForValue(
          layout.valueAt(row, column),
          nextRange,
          props.scale,
          props.colormap,
        );
        if (color) {
          image.data[target] = color[0];
          image.data[target + 1] = color[1];
          image.data[target + 2] = color[2];
          image.data[target + 3] = 255;
        } else {
          image.data[target] = 238;
          image.data[target + 1] = 238;
          image.data[target + 2] = 238;
          image.data[target + 3] = 255;
        }
      }
    }
    context.putImageData(image, 0, 0);
  }, [
    slice,
    layout,
    props.colormap,
    props.scale,
    props.range.minimum,
    props.range.maximum,
    props.rangeLocked,
    props.onRange,
    view,
  ]);

  const inspectPointer = (event: PointerEvent<HTMLCanvasElement>): HoverValue | undefined => {
    if (!layout) return undefined;
    const bounds = event.currentTarget.getBoundingClientRect();
    const visible = fieldWindow(layout, view);
    const screenX = Math.max(0, Math.min(bounds.width - 1, event.clientX - bounds.left));
    const screenY = Math.max(0, Math.min(bounds.height - 1, event.clientY - bounds.top));
    let column = visible.firstColumn + Math.floor((screenX / bounds.width) * visible.columns);
    let row = visible.firstRow + Math.floor((screenY / bounds.height) * visible.rows);
    if (layout.flipX) column = layout.columns - 1 - column;
    if (layout.flipY) row = layout.rows - 1 - row;
    const sourceX = Math.min(
      layout.xDimension.length - 1,
      column * layout.xStride,
    );
    const sourceY = Math.min(
      layout.yDimension.length - 1,
      row * layout.yStride,
    );
    return {
      left: event.clientX - frame.current!.getBoundingClientRect().left,
      top: event.clientY - frame.current!.getBoundingClientRect().top,
      x: coordinates.x?.[sourceX] ?? sourceX,
      y: coordinates.y?.[sourceY] ?? sourceY,
      value: layout.valueAt(row, column),
      sourceX,
      sourceY,
    };
  };

  const selectProbe = (event: PointerEvent<HTMLCanvasElement>) => {
    const inspected = inspectPointer(event);
    if (!inspected || !layout) return;
    props.onProbe(probeAtPosition(props.metadata, props.variable, {
      indices: {
        ...props.indices,
        [layout.xDimension.path]: inspected.sourceX,
        [layout.yDimension.path]: inspected.sourceY,
      },
      x: inspected.x,
      y: inspected.y,
      value: inspected.value,
    }));
  };

  const xLabel = coordinateLabel(props.metadata, props.variable, "x", layout?.xDimension.name);
  const yLabel = coordinateLabel(props.metadata, props.variable, "y", layout?.yDimension.name);
  const probePosition = layout && props.probe
    ? visibleProbePosition(layout.probePosition(props.probe), view)
    : undefined;
  const xDomain = layout
    ? visibleDomain(layout.xDomain, view.minimumX, view.maximumX)
    : [0, 1] as [number, number];
  const yDomain = layout
    ? visibleDomain(layout.yDomain, view.minimumY, view.maximumY)
    : [0, 1] as [number, number];

  const finishPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const activeDrag = drag.current;
    if (!activeDrag) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const end = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    drag.current = undefined;
    setDragBox(undefined);
    if (activeDrag.mode === "pan") return;
    const movedX = Math.abs(end.x - activeDrag.start.x);
    const movedY = Math.abs(end.y - activeDrag.start.y);
    if (movedX >= 8 || movedY >= 8) {
      const box = aspectRectangle(activeDrag.start, end, bounds.width, bounds.height);
      changeView(boxZoomBounds(activeDrag.view, box, bounds.width, bounds.height));
    } else {
      selectProbe(event);
    }
  };

  return (
    <div className="plot-frame field-frame" ref={frame}>
      {props.variable.dimensions.length === 0 ? (
        <div className="scalar-value" aria-label={`${props.variable.name} scalar value`}>
          <strong>{slice ? formatNumber(Number(slice.values[0])) : "—"}</strong>
          <span>{variableUnit(props.variable)}</span>
          <small>{props.variable.dtype}</small>
        </div>
      ) : (
        <>
          <canvas
            ref={canvas}
            className="field-canvas"
            style={{ left: plot.left, top: plot.top, width: plot.width, height: plot.height }}
            onPointerLeave={() => !drag.current && setHover(undefined)}
            onDoubleClick={() => changeView(FULL_FIELD)}
            onAuxClick={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (event.button !== 0 && event.button !== 1) return;
              if (event.button === 1) event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              drag.current = {
                mode: event.button === 1 ? "pan" : "zoom",
                start: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
                view,
              };
              if (event.pointerId) event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (drag.current) {
                const bounds = event.currentTarget.getBoundingClientRect();
                const end = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
                if (drag.current.mode === "pan") {
                  changeView(panBounds(
                    drag.current.view,
                    FULL_FIELD,
                    (end.x - drag.current.start.x) / bounds.width,
                    (end.y - drag.current.start.y) / bounds.height,
                  ));
                  setHover(undefined);
                } else {
                  setDragBox(aspectRectangle(
                    drag.current.start,
                    end,
                    bounds.width,
                    bounds.height,
                  ));
                }
              } else {
                setHover(inspectPointer(event));
              }
            }}
            onPointerUp={finishPointer}
            onPointerCancel={() => {
              drag.current = undefined;
              setDragBox(undefined);
            }}
            aria-label={`${props.variable.name} field`}
          />
          <svg className="plot-svg" width={frameSize.width} height={frameSize.height} aria-hidden="true">
            <PlotAxes
              plot={plot}
              xDomain={xDomain}
              yDomain={yDomain}
              xLabel={xLabel}
              yLabel={yLabel}
            />
            {probePosition && (
              <g
                className="probe-mark"
                transform={`translate(${plot.left + probePosition.x * plot.width} ${plot.top + probePosition.y * plot.height})`}
              >
                <line x1={-9} x2={9} />
                <line y1={-9} y2={9} />
                <circle r={3.5} />
              </g>
            )}
            {dragBox && (
              <rect
                className="zoom-box"
                x={plot.left + dragBox.left}
                y={plot.top + dragBox.top}
                width={dragBox.width}
                height={dragBox.height}
              />
            )}
          </svg>
          {props.mapSource === "osm" && layout && (
            <div className="map-position" style={{ left: plot.left, top: plot.top, width: plot.width, height: plot.height }}>
              <MapOverlay
                bounds={{ minimumX: xDomain[0], maximumX: xDomain[1], minimumY: yDomain[0], maximumY: yDomain[1] }}
                width={plot.width}
                height={plot.height}
              />
            </div>
          )}
          <Colorbar range={props.range} colormap={props.colormap} scale={props.scale} />
          <ViewControls
            onZoomIn={() => changeView(zoomBounds(view, FULL_FIELD, 0.75))}
            onZoomOut={() => changeView(zoomBounds(view, FULL_FIELD, 4 / 3))}
            onReset={() => changeView(FULL_FIELD)}
          />
        </>
      )}
      {hover && (
        <output
          className="plot-tooltip"
          style={{ left: Math.min(frameSize.width - 210, hover.left + 14), top: hover.top + 12 }}
        >
          <strong>{formatNumber(hover.value)}</strong> {variableUnit(props.variable)}
          <span>{formatPosition(props.metadata, props.variable, hover.x, hover.y)}</span>
        </output>
      )}
      {loading && <span className="plot-loading">reading newest slice…</span>}
      {error && <div className="plot-error">{error}</div>}
    </div>
  );
}

function fieldLayout(
  variable: Variable,
  display: DisplayDimensions,
  slice: DataSlice | undefined,
  coordinates: Coordinates,
) {
  if (
    display.x === undefined ||
    display.y === undefined ||
    display.x === display.y ||
    display.x < 0 ||
    display.y < 0 ||
    display.x >= variable.dimensions.length ||
    display.y >= variable.dimensions.length ||
    !slice ||
    slice.shape.length !== 2
  ) {
    return undefined;
  }
  const remaining = variable.dimensions
    .map((_, index) => index)
    .filter((index) => index === display.x || index === display.y);
  const xPosition = remaining.indexOf(display.x);
  const yPosition = remaining.indexOf(display.y);
  const columns = slice.shape[xPosition];
  const rows = slice.shape[yPosition];
  const xDimension = variable.dimensions[display.x];
  const yDimension = variable.dimensions[display.y];
  const requestStride = slice.request.stride.split(",").map(Number);
  const xStride = requestStride[display.x];
  const yStride = requestStride[display.y];
  const flipX = coordinates.x
    ? coordinates.x.at(-1)! < coordinates.x[0]
    : false;
  const flipY = coordinates.y
    ? coordinates.y.at(-1)! > coordinates.y[0]
    : true;
  const valueAt = (row: number, column: number) => {
    const index = yPosition === 0 ? row * columns + column : column * rows + row;
    return Number(slice.values[index]);
  };
  const xDomain: [number, number] = coordinates.x
    ? [Math.min(coordinates.x[0], coordinates.x.at(-1)!), Math.max(coordinates.x[0], coordinates.x.at(-1)!)]
    : [0, xDimension.length - 1];
  const yDomain: [number, number] = coordinates.y
    ? [Math.min(coordinates.y[0], coordinates.y.at(-1)!), Math.max(coordinates.y[0], coordinates.y.at(-1)!)]
    : [0, yDimension.length - 1];
  return {
    columns,
    rows,
    xDimension,
    yDimension,
    xStride,
    yStride,
    flipX,
    flipY,
    xDomain,
    yDomain,
    valueAt,
    probePosition: (probe: Probe) => {
      const sourceX = probe.indices[xDimension.path];
      const sourceY = probe.indices[yDimension.path];
      if (sourceX === undefined || sourceY === undefined) return undefined;
      const fractionX = sourceX / Math.max(1, xDimension.length - 1);
      const fractionY = sourceY / Math.max(1, yDimension.length - 1);
      return {
        x: flipX ? 1 - fractionX : fractionX,
        y: flipY ? fractionY : 1 - fractionY,
      };
    },
  };
}

function fieldWindow(
  layout: NonNullable<ReturnType<typeof fieldLayout>>,
  view: ViewBounds,
) {
  const left = view.minimumX;
  const right = view.maximumX;
  const top = 1 - view.maximumY;
  const bottom = 1 - view.minimumY;
  const firstColumn = Math.min(layout.columns - 1, Math.floor(left * layout.columns));
  const lastColumn = Math.max(
    firstColumn + 1,
    Math.min(layout.columns, Math.ceil(right * layout.columns)),
  );
  const firstRow = Math.min(layout.rows - 1, Math.floor(top * layout.rows));
  const lastRow = Math.max(
    firstRow + 1,
    Math.min(layout.rows, Math.ceil(bottom * layout.rows)),
  );
  return {
    firstColumn,
    firstRow,
    columns: lastColumn - firstColumn,
    rows: lastRow - firstRow,
  };
}

function visibleProbePosition(
  position: { x: number; y: number } | undefined,
  view: ViewBounds,
): { x: number; y: number } | undefined {
  if (
    !position ||
    position.x < view.minimumX ||
    position.x > view.maximumX ||
    position.y < view.minimumY ||
    position.y > view.maximumY
  ) {
    return undefined;
  }
  return {
    x: (position.x - view.minimumX) / (view.maximumX - view.minimumX),
    y: 1 - (position.y - view.minimumY) / (view.maximumY - view.minimumY),
  };
}

function visibleDomain(
  domain: [number, number],
  minimum: number,
  maximum: number,
): [number, number] {
  const span = domain[1] - domain[0];
  return [domain[0] + minimum * span, domain[0] + maximum * span];
}

export interface PlotBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function PlotAxes({
  plot,
  xDomain,
  yDomain,
  xLabel,
  yLabel,
}: {
  plot: PlotBounds;
  xDomain: [number, number];
  yDomain: [number, number];
  xLabel: string;
  yLabel: string;
}) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <g className="plot-axis">
      <path d={`M${plot.left} ${plot.top}V${plot.top + plot.height}H${plot.left + plot.width}`} />
      {ticks.map((fraction) => {
        const x = plot.left + fraction * plot.width;
        const value = xDomain[0] + fraction * (xDomain[1] - xDomain[0]);
        return (
          <g key={`x-${fraction}`}>
            <line x1={x} x2={x} y1={plot.top + plot.height} y2={plot.top + plot.height + 5} />
            <text x={x} y={plot.top + plot.height + 18} textAnchor="middle">{formatNumber(value)}</text>
          </g>
        );
      })}
      {ticks.map((fraction) => {
        const y = plot.top + (1 - fraction) * plot.height;
        const value = yDomain[0] + fraction * (yDomain[1] - yDomain[0]);
        return (
          <g key={`y-${fraction}`}>
            <line x1={plot.left - 5} x2={plot.left} y1={y} y2={y} />
            <text x={plot.left - 9} y={y + 4} textAnchor="end">{formatNumber(value)}</text>
          </g>
        );
      })}
      <text className="axis-label" x={plot.left + plot.width / 2} y={plot.top + plot.height + 42} textAnchor="middle">{xLabel}</text>
      <text className="axis-label" transform={`translate(18 ${plot.top + plot.height / 2}) rotate(-90)`} textAnchor="middle">{yLabel}</text>
    </g>
  );
}

function coordinateLabel(
  metadata: Metadata,
  variable: Variable,
  axis: "x" | "y",
  fallback: string = axis,
): string {
  if (variable.view_hint.kind !== "rectilinear") return fallback;
  const path = variable.view_hint[axis];
  const coordinate = metadata.variables.find((candidate) => candidate.path === path);
  if (!coordinate) return fallback;
  const units = attributeText(coordinate, "units");
  return units ? `${coordinate.name} (${units})` : coordinate.name;
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

export function Colorbar({
  range,
  colormap,
  scale,
}: {
  range: ColorRange;
  colormap: Colormap;
  scale: ColorScale;
}) {
  return (
    <div className="colorbar" aria-label={`${colormap} color range`}>
      <span>{formatNumber(range.maximum)}</span>
      <i data-colormap={colormap} />
      <span>{formatNumber(range.minimum)}</span>
      <small>{scale}</small>
    </div>
  );
}
