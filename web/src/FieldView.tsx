import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { LatestSliceLoader, fetchCoordinate } from "./api";
import {
  colorForValue,
  finiteRange,
  formatNumber,
  type ColormapChoice,
  type ColorRange,
} from "./color";
import type {
  ColorScale,
  DataSlice,
  Metadata,
  Probe,
  Variable,
} from "./model";
import { displayUnit, quantityLabel } from "./model";
import { formatPosition, probeAtPosition } from "./projection";
import { fieldRequest, type DisplayDimensions } from "./selection";
import { useElementSize } from "./useElementSize";
import { plotMargin, plotType, type PlotType } from "./plotgeom";
import { MapOverlay } from "./MapOverlay";
import { Colorbar, PlotAxes, ViewControls, colorbarWidth } from "./plot";
import {
  aspectRectangle,
  boxZoomBounds,
  fitPlotToBounds,
  panBounds,
  projectRectangle,
  zoomBounds,
  type ViewBounds,
  type ViewRectangle,
} from "./view";

/** Furniture margin for a field panel, derived from the live type size rather
 *  than fixed: the labels grow with the panel, and so must the room for them. */
export function fieldMargin(type: PlotType) {
  return plotMargin(type, { colorbar: 14 + colorbarWidth(type) });
}

interface FieldViewProps {
  metadata: Metadata;
  variable: Variable;
  display: DisplayDimensions;
  indices: Record<string, number>;
  settled: boolean;
  colormap: ColormapChoice;
  scale: ColorScale;
  range: ColorRange;
  rangeLocked: boolean;
  sharedRange?: boolean;
  mapSource: "none" | "osm";
  probe: Probe | undefined;
  initialView?: ViewBounds;
  controlledView?: ViewBounds;
  controlledWorldView?: ViewBounds;
  onViewChange: (view: ViewBounds) => void;
  onWorldViewChange?: (view: ViewBounds) => void;
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
  const sourceCanvas = useRef<HTMLCanvasElement | null>(null);
  const rasterImage = useRef<ImageData | null>(null);
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
    if (layout && props.onWorldViewChange) {
      props.onWorldViewChange(worldView(layout, nextView));
    }
  };
  useEffect(() => {
    if (props.controlledView) setView(props.controlledView);
  }, [
    props.controlledView?.minimumX,
    props.controlledView?.maximumX,
    props.controlledView?.minimumY,
    props.controlledView?.maximumY,
  ]);

  const type = plotType(frame.current);
  const margin = fieldMargin(type);
  const availablePlot = {
    left: margin.left,
    top: margin.top,
    width: Math.max(1, frameSize.width - margin.left - margin.right),
    height: Math.max(1, frameSize.height - margin.top - margin.bottom),
  };
  const request = useMemo(
    () => {
      const ratio = props.settled ? Math.min(2, window.devicePixelRatio || 1) : 1;
      return fieldRequest(
        props.variable,
        props.display,
        props.indices,
        { width: availablePlot.width * ratio, height: availablePlot.height * ratio },
        props.settled,
        sourceRegion(view, coordinates),
      );
    },
    [
      props.variable,
      props.display,
      props.indices,
      props.settled,
      availablePlot.width,
      availablePlot.height,
      view,
      coordinates,
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
  }, [request.dataset, request.path, request.selection, request.stride, props.onFrameLoaded, props.onStatus]);

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
  useEffect(() => {
    if (layout && props.controlledWorldView) {
      setView(normalizedView(layout, props.controlledWorldView));
    }
  }, [
    layout,
    props.controlledWorldView?.minimumX,
    props.controlledWorldView?.maximumX,
    props.controlledWorldView?.minimumY,
    props.controlledWorldView?.maximumY,
  ]);
  const plot = layout
    ? fitPlotToBounds(availablePlot, {
        minimumX: layout.xDomain[0],
        maximumX: layout.xDomain[1],
        minimumY: layout.yDomain[0],
        maximumY: layout.yDomain[1],
      })
    : availablePlot;
  const automaticRange = useMemo(
    () => slice?.values instanceof Float32Array
      ? finiteRange(slice.values, props.colormap)
      : undefined,
    [slice, props.colormap],
  );
  const renderRange = props.rangeLocked || props.sharedRange ? props.range : automaticRange;

  useEffect(() => {
    if (
      automaticRange &&
      !props.rangeLocked &&
      (automaticRange.minimum !== props.range.minimum || automaticRange.maximum !== props.range.maximum)
    ) {
      props.onRange(automaticRange);
    }
  }, [automaticRange, props.range.minimum, props.range.maximum, props.rangeLocked, props.onRange]);

  // Keep colour conversion off the pan path. View-only changes composite this cached raster.
  useEffect(() => {
    if (!slice || !layout || !renderRange || !(slice.values instanceof Float32Array)) return;
    const source = sourceCanvas.current ?? document.createElement("canvas");
    sourceCanvas.current = source;
    if (source.width !== layout.columns || source.height !== layout.rows) {
      source.width = layout.columns;
      source.height = layout.rows;
      rasterImage.current = null;
    }
    const context = source.getContext("2d", { alpha: false });
    if (!context) return;
    const image = rasterImage.current ?? context.createImageData(layout.columns, layout.rows);
    rasterImage.current = image;
    for (let targetRow = 0; targetRow < layout.rows; targetRow += 1) {
      const row = layout.flipY ? layout.rows - 1 - targetRow : targetRow;
      for (let targetColumn = 0; targetColumn < layout.columns; targetColumn += 1) {
        const column = layout.flipX ? layout.columns - 1 - targetColumn : targetColumn;
        const target = (targetRow * layout.columns + targetColumn) * 4;
        const color = colorForValue(
          layout.valueAt(row, column),
          renderRange,
          props.scale,
          props.colormap,
        );
        if (color) {
          image.data[target] = color[0];
          image.data[target + 1] = color[1];
          image.data[target + 2] = color[2];
        } else {
          image.data[target] = 238;
          image.data[target + 1] = 238;
          image.data[target + 2] = 238;
        }
        image.data[target + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [
    slice,
    layout,
    props.colormap,
    props.scale,
    renderRange?.minimum,
    renderRange?.maximum,
  ]);

  useEffect(() => {
    const node = canvas.current;
    const source = sourceCanvas.current;
    if (!node || !source || !slice || !layout || !renderRange) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(plot.width * ratio));
    const height = Math.max(1, Math.round(plot.height * ratio));
    if (node.width !== width || node.height !== height) {
      node.width = width;
      node.height = height;
    }
    const context = node.getContext("2d", { alpha: false });
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.fillStyle = "#eee";
    context.fillRect(0, 0, width, height);
    const destination = projectRectangle(fieldSliceBounds(layout), view, width, height);
    context.drawImage(source, destination.left, destination.top, destination.width, destination.height);
    // Announce a painted canvas, as the mesh view does. A fresh canvas is
    // 300x150 with no pixels drawn, so its size cannot say whether the slice
    // has actually reached the screen.
    node.dataset.rendered = "true";
  }, [
    slice,
    layout,
    props.colormap,
    props.scale,
    renderRange?.minimum,
    renderRange?.maximum,
    plot.width,
    plot.height,
    view,
  ]);

  const inspectPointer = (event: PointerEvent<HTMLCanvasElement>): HoverValue | undefined => {
    if (!layout) return undefined;
    const bounds = event.currentTarget.getBoundingClientRect();
    const screenX = Math.max(0, Math.min(bounds.width - 1, event.clientX - bounds.left));
    const screenY = Math.max(0, Math.min(bounds.height - 1, event.clientY - bounds.top));
    const cell = fieldCell(layout, view, screenX / bounds.width, screenY / bounds.height);
    if (!cell) return undefined;
    const { column, row } = cell;
    const sourceX = Math.min(
      layout.xDimension.length - 1,
      layout.xStart + column * layout.xStride,
    );
    const sourceY = Math.min(
      layout.yDimension.length - 1,
      layout.yStart + row * layout.yStride,
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
          <span>{displayUnit(props.variable)}</span>
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
              type={type}
              plot={plot}
              xDomain={xDomain}
              yDomain={yDomain}
              xLabel={xLabel}
              yLabel={yLabel}
              boxed
            />
            <Colorbar
              type={type}
              plot={plot}
              range={props.range}
              colormap={props.colormap}
              scale={props.scale}
              label={quantityLabel(props.variable)}
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
          <strong>{formatNumber(hover.value)}</strong> {displayUnit(props.variable)}
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
  const requestSelection = slice.request.selection.split(",");
  const selectedRange = (index: number, length: number) => {
    const [start, stop] = requestSelection[index].split(":");
    return [Number(start || 0), Number(stop || length)] as const;
  };
  const xStride = requestStride[display.x];
  const yStride = requestStride[display.y];
  const [xStart, xStop] = selectedRange(display.x, xDimension.length);
  const [yStart, yStop] = selectedRange(display.y, yDimension.length);
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
    xStart,
    xStop,
    yStart,
    yStop,
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
      const coordinateFraction = (value: number, domain: [number, number]) =>
        (value - domain[0]) / (domain[1] - domain[0]);
      const fractionX = sourceX === undefined
        ? coordinateFraction(probe.x, xDomain)
        : (flipX ? 1 - sourceX / Math.max(1, xDimension.length - 1) : sourceX / Math.max(1, xDimension.length - 1));
      const fractionY = sourceY === undefined
        ? coordinateFraction(probe.y, yDomain)
        : (flipY ? sourceY / Math.max(1, yDimension.length - 1) : 1 - sourceY / Math.max(1, yDimension.length - 1));
      if (!Number.isFinite(fractionX) || !Number.isFinite(fractionY)) return undefined;
      return {
        x: fractionX,
        y: fractionY,
      };
    },
  };
}

function fieldSliceBounds(
  layout: NonNullable<ReturnType<typeof fieldLayout>>,
): ViewRectangle {
  const xLength = layout.xDimension.length;
  const yLength = layout.yDimension.length;
  const left = layout.flipX ? 1 - layout.xStop / xLength : layout.xStart / xLength;
  const right = layout.flipX ? 1 - layout.xStart / xLength : layout.xStop / xLength;
  const top = layout.flipY ? 1 - layout.yStop / yLength : layout.yStart / yLength;
  const bottom = layout.flipY ? 1 - layout.yStart / yLength : layout.yStop / yLength;
  return { left, top, width: right - left, height: bottom - top };
}

function fieldCell(
  layout: NonNullable<ReturnType<typeof fieldLayout>>,
  view: ViewBounds,
  screenX: number,
  screenY: number,
): { column: number; row: number } | undefined {
  const bounds = fieldSliceBounds(layout);
  const x = view.minimumX + screenX * (view.maximumX - view.minimumX);
  const y = 1 - view.maximumY + screenY * (view.maximumY - view.minimumY);
  const columnFraction = (x - bounds.left) / bounds.width;
  const rowFraction = (y - bounds.top) / bounds.height;
  if (columnFraction < 0 || columnFraction >= 1 || rowFraction < 0 || rowFraction >= 1) {
    return undefined;
  }
  let column = Math.min(layout.columns - 1, Math.floor(columnFraction * layout.columns));
  let row = Math.min(layout.rows - 1, Math.floor(rowFraction * layout.rows));
  if (layout.flipX) column = layout.columns - 1 - column;
  if (layout.flipY) row = layout.rows - 1 - row;
  return { column, row };
}

function sourceRegion(view: ViewBounds, coordinates: Coordinates): ViewBounds {
  const flipX = coordinates.x ? coordinates.x.at(-1)! < coordinates.x[0] : false;
  const flipY = coordinates.y ? coordinates.y.at(-1)! > coordinates.y[0] : true;
  return {
    minimumX: flipX ? 1 - view.maximumX : view.minimumX,
    maximumX: flipX ? 1 - view.minimumX : view.maximumX,
    minimumY: flipY ? view.minimumY : 1 - view.maximumY,
    maximumY: flipY ? view.maximumY : 1 - view.minimumY,
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

function worldView(
  layout: NonNullable<ReturnType<typeof fieldLayout>>,
  view: ViewBounds,
): ViewBounds {
  const x = visibleDomain(layout.xDomain, view.minimumX, view.maximumX);
  const y = visibleDomain(layout.yDomain, view.minimumY, view.maximumY);
  return { minimumX: x[0], maximumX: x[1], minimumY: y[0], maximumY: y[1] };
}

function normalizedView(
  layout: NonNullable<ReturnType<typeof fieldLayout>>,
  view: ViewBounds,
): ViewBounds {
  const axis = (minimum: number, maximum: number, domain: [number, number]) => {
    const span = domain[1] - domain[0];
    if (!Number.isFinite(span) || span <= 0) return [0, 1] as const;
    const fraction = (value: number) => Math.max(0, Math.min(1, (value - domain[0]) / span));
    return [fraction(minimum), fraction(maximum)] as const;
  };
  const x = axis(view.minimumX, view.maximumX, layout.xDomain);
  const y = axis(view.minimumY, view.maximumY, layout.yDomain);
  return {
    minimumX: x[0],
    maximumX: x[1],
    minimumY: y[0],
    maximumY: y[1],
  };
}

export function coordinateLabel(
  metadata: Metadata,
  variable: Variable,
  axis: "x" | "y",
  fallback: string = axis,
): string {
  const hint = variable.view_hint;
  if (hint.kind === "plain") return fallback;
  const coordinate = metadata.variables.find((candidate) => candidate.path === hint[axis]);
  if (!coordinate) return fallback;
  return quantityLabel(coordinate);
}
