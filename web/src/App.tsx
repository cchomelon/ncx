import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchCoordinate, fetchMetadata } from "./api";
import { CurveView } from "./CurveView";
import { FieldView } from "./FieldView";
import { MeshFieldView } from "./MeshFieldView";
import { MetadataPanel } from "./MetadataPanel";
import { formatNumber, type ColorRange } from "./color";
import type {
  Colormap,
  ColorScale,
  Metadata,
  Probe,
  Variable,
  ViewName,
} from "./model";
import {
  attributeText,
  isNumeric,
  meshGeometryPaths,
  variableLabel,
  variableUnit,
} from "./model";
import { formatProbePosition } from "./projection";
import {
  defaultDisplayDimensions,
  defaultIndices,
  SETTLE_DELAY_MS,
  type DisplayDimensions,
} from "./selection";
import {
  describeTime,
  formatTimestamp,
  timeTickLabel,
  type TimeDescription,
} from "./time";
import type { ViewBounds } from "./view";

export function App() {
  const [metadata, setMetadata] = useState<Metadata>();
  const [startupError, setStartupError] = useState<string>();
  const [selectedPath, setSelectedPath] = useState("");
  const [display, setDisplay] = useState<DisplayDimensions>({ x: undefined, y: undefined });
  const [indices, setIndices] = useState<Record<string, number>>({});
  const [settled, setSettled] = useState(false);
  const [view, setView] = useState<ViewName>("field");
  const [probe, setProbe] = useState<Probe>();
  const [colormap, setColormap] = useState<Colormap>("viridis");
  const [scale, setScale] = useState<ColorScale>("linear");
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [status, setStatus] = useState("opening dataset…");
  const [playDirection, setPlayDirection] = useState<-1 | 0 | 1>(0);
  const [timelineValues, setTimelineValues] = useState<Float32Array>();
  const [frameReady, setFrameReady] = useState(true);
  const [colorRange, setColorRange] = useState<ColorRange>({ minimum: 0, maximum: 1 });
  const [rangeLocked, setRangeLocked] = useState(false);
  const [coordinatePaths, setCoordinatePaths] = useState<{ x?: string; y?: string }>({});
  const [mapSource, setMapSource] = useState<"none" | "osm">("none");
  const fieldViews = useRef(new Map<string, ViewBounds>());

  useEffect(() => {
    fetchMetadata()
      .then((nextMetadata) => {
        setMetadata(nextMetadata);
        const initial =
          nextMetadata.variables.find(
            (variable) => isNumeric(variable) && variable.view_hint.kind !== "plain",
          ) ??
          nextMetadata.variables.find(
            (variable) => isNumeric(variable) && variable.dimensions.length >= 2,
          ) ?? nextMetadata.variables.find(isNumeric);
        if (initial) setSelectedPath(initial.path);
        setStatus(`${nextMetadata.variables.length} variables · metadata ready`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setStartupError(message);
        setStatus(message);
      });
  }, []);

  const variable = metadata?.variables.find((candidate) => candidate.path === selectedPath);

  useEffect(() => {
    if (!metadata || !variable) return;
    const nextIndices = defaultIndices(variable);
    for (const dimension of variable.dimensions) {
      const discovered = metadata.dimensions.find((candidate) => candidate.path === dimension.path);
      if (discovered?.unlimited) nextIndices[dimension.path] = Math.max(0, dimension.length - 1);
    }
    const nextDisplay = defaultDisplayDimensions(variable);
    setDisplay(nextDisplay);
    setIndices(nextIndices);
    setProbe(undefined);
    setPlayDirection(0);
    setFrameReady(true);
    setRangeLocked(false);
    setColorRange({ minimum: 0, maximum: 1 });
    setCoordinatePaths(
      variable.view_hint.kind === "rectilinear" || variable.view_hint.kind === "curvilinear"
        ? { x: variable.view_hint.x, y: variable.view_hint.y }
        : {},
    );
    setView(
      variable.dimensions.length === 1 && variable.view_hint.kind !== "ugrid2d"
        ? "curve"
        : "field",
    );
  }, [metadata, variable]);

  useEffect(() => {
    setSettled(false);
    const timer = window.setTimeout(() => setSettled(true), SETTLE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [selectedPath, display, indices]);

  const selectorDimensions = useMemo(() => {
    if (!variable) return [];
    return variable.dimensions
      .map((dimension, index) => ({ dimension, index }))
      .filter(({ index }) => index !== display.x && index !== display.y);
  }, [variable, display]);
  const timeline = selectorDimensions[0];
  const timelineVariable = metadata?.variables.find(
    (candidate) =>
      candidate.path === timeline?.dimension.path &&
      candidate.dimensions.length === 1 &&
      candidate.dimensions[0].path === timeline.dimension.path,
  );
  const timelineTime = describeTime(timelineVariable);
  const curveDimension = timeline?.index ?? display.x ?? 0;
  const curveIndices = probe?.indices ?? indices;

  useEffect(() => {
    let active = true;
    if (!timelineVariable) {
      setTimelineValues(undefined);
      return;
    }
    fetchCoordinate(timelineVariable)
      .then((values) => {
        if (active) setTimelineValues(values);
      })
      .catch(() => {
        if (active) setTimelineValues(undefined);
      });
    return () => {
      active = false;
    };
  }, [timelineVariable]);

  useEffect(() => {
    if (!timeline || playDirection === 0 || !frameReady) return;
    const timer = window.setTimeout(() => {
      setFrameReady(false);
      setIndices((current) => {
        const value = current[timeline.dimension.path] ?? 0;
        const next = (value + playDirection + timeline.dimension.length) % timeline.dimension.length;
        return { ...current, [timeline.dimension.path]: next };
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [timeline, playDirection, frameReady]);

  const updateStatus = useCallback((message: string) => setStatus(message), []);
  const updateIndex = (path: string, value: number) => {
    setFrameReady(false);
    setIndices((current) => ({ ...current, [path]: value }));
  };
  const markFrameLoaded = useCallback(() => setFrameReady(true), []);
  const fieldVariable = useMemo(
    () => metadata && variable
      ? variableWithCoordinates(metadata, variable, display, coordinatePaths)
      : variable,
    [metadata, variable, display, coordinatePaths],
  );
  const fieldViewKey = fieldVariable
    ? [
        fieldVariable.path,
        fieldVariable.view_hint.kind,
        display.x ?? "none",
        display.y ?? "none",
        coordinatePaths.x ?? "index",
        coordinatePaths.y ?? "index",
      ].join(":")
    : "";
  const rememberFieldView = useCallback(
    (nextView: ViewBounds) => fieldViews.current.set(fieldViewKey, nextView),
    [fieldViewKey],
  );

  if (!metadata || !variable || !fieldVariable) {
    return (
      <main className="startup">
        <strong className="brand">ncx</strong>
        <p>{startupError ?? "Opening NetCDF metadata…"}</p>
      </main>
    );
  }

  const timelineIndex = timeline ? indices[timeline.dimension.path] ?? 0 : undefined;
  const figureTitle = fieldTitle(
    variable,
    timeline?.dimension.name,
    timelineIndex,
    timelineIndex === undefined ? undefined : timelineValues?.[timelineIndex],
    timelineTime,
  );
  const probePosition = probe
    ? formatProbePosition(metadata, fieldVariable, probe)
    : undefined;
  const figureSubtitle = [
    variableLabel(variable),
    variableUnit(variable),
    fieldVariable.view_hint.kind,
    probePosition ? `probe ${probePosition}` : undefined,
  ].filter(Boolean).join(" · ");
  const meshField = hasCompatibleMeshCoordinates(metadata, fieldVariable, display);
  const xCoordinates = compatibleCoordinates(metadata, variable, display, "x");
  const yCoordinates = compatibleCoordinates(metadata, variable, display, "y");
  const geographicField = hasGeographicCoordinates(metadata, fieldVariable);

  return (
    <div className="shell" data-sidebar={sidebarOpen ? "open" : "closed"}>
      <header className="topbar">
        <button
          className="sidebar-toggle"
          aria-label="Toggle dataset browser"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          ☰
        </button>
        <strong className="brand">ncx</strong>
        <span className="path"><b>{metadata.dataset.name}</b><i>/</i>{variable.path.slice(1)}</span>
        <span className="read-only">READ ONLY</span>
      </header>

      <DatasetBrowser
        metadata={metadata}
        selectedPath={selectedPath}
        search={search}
        onSearch={setSearch}
        onSelect={(path) => {
          setSelectedPath(path);
          setSidebarOpen(window.innerWidth > 760);
        }}
      />

      <main className="main">
        <div className="toolbar">
          <nav className="view-tabs" aria-label="Variable views">
            {(["field", "curve", "metadata"] as const).map((name) => (
              <button
                key={name}
                className={view === name ? "active" : ""}
                disabled={
                  (name === "field" && variable.dimensions.length === 1 && variable.view_hint.kind !== "ugrid2d") ||
                  (name === "curve" && variable.dimensions.length === 0)
                }
                onClick={() => {
                  setFrameReady(false);
                  setView(name);
                }}
              >
                {name === "field" && variable.dimensions.length === 0
                  ? "Value"
                  : name[0].toUpperCase() + name.slice(1)}
              </button>
            ))}
          </nav>
          <div className="display-controls">
            {variable.view_hint.kind === "ugrid2d" ? (
              <label className="dimension-readout">
                {variable.view_hint.location}
                <output>
                  {display.x === undefined
                    ? "unresolved"
                    : `${variable.dimensions[display.x]?.name} (${variable.dimensions[display.x]?.length})`}
                </output>
              </label>
            ) : variable.dimensions.length >= 2 && (
              <>
                <label>Y <DimensionSelect variable={variable} value={display.y} onChange={(y) => {
                  setCoordinatePaths({});
                  setProbe(undefined);
                  setDisplay((current) => changeDisplayDimension(current, "y", y));
                }} /></label>
                <label>X <DimensionSelect variable={variable} value={display.x} onChange={(x) => {
                  setCoordinatePaths({});
                  setProbe(undefined);
                  setDisplay((current) => changeDisplayDimension(current, "x", x));
                }} /></label>
                <label>
                  Y coord
                  <CoordinateSelect
                    candidates={yCoordinates}
                    value={coordinatePaths.y}
                    onChange={(y) => {
                      setCoordinatePaths((current) => ({ ...current, y }));
                      setProbe(undefined);
                    }}
                  />
                </label>
                <label>
                  X coord
                  <CoordinateSelect
                    candidates={xCoordinates}
                    value={coordinatePaths.x}
                    onChange={(x) => {
                      setCoordinatePaths((current) => ({ ...current, x }));
                      setProbe(undefined);
                    }}
                  />
                </label>
              </>
            )}
            {selectorDimensions.map(({ dimension }) => (
              <label key={dimension.path}>
                {dimension.name}
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, dimension.length - 1)}
                  value={indices[dimension.path] ?? 0}
                  onChange={(event) => updateIndex(dimension.path, Number(event.target.value))}
                />
              </label>
            ))}
            <label>
              Colour
              <select value={colormap} onChange={(event) => setColormap(event.target.value as Colormap)}>
                <option value="viridis">viridis</option>
                <option value="thermal">thermal</option>
                <option value="balance">balance</option>
                <option value="grayscale">grayscale</option>
              </select>
            </label>
            <label>
              Scale
              <select value={scale} onChange={(event) => setScale(event.target.value as ColorScale)}>
                <option value="linear">linear</option>
                <option value="log">log</option>
                <option value="symlog">symlog</option>
              </select>
            </label>
            {geographicField && (
              <label>
                Map
                <select value={mapSource} onChange={(event) => setMapSource(event.target.value as "none" | "osm")}>
                  <option value="none">none</option>
                  <option value="osm">OSM reference</option>
                </select>
              </label>
            )}
            {variable.dimensions.length >= 2 && (
              <>
                <label>
                  Range
                  <select
                    value={rangeLocked ? "locked" : "auto"}
                    onChange={(event) => setRangeLocked(event.target.value === "locked")}
                  >
                    <option value="auto">auto</option>
                    <option value="locked">locked</option>
                  </select>
                </label>
                {rangeLocked && (
                  <label className="range-values">
                    Min
                    <input
                      aria-label="Colour range minimum"
                      type="number"
                      step="any"
                      value={colorRange.minimum}
                      onChange={(event) => setColorRange((current) => ({
                        ...current,
                        minimum: Math.min(Number(event.target.value), current.maximum - Number.EPSILON),
                      }))}
                    />
                    Max
                    <input
                      aria-label="Colour range maximum"
                      type="number"
                      step="any"
                      value={colorRange.maximum}
                      onChange={(event) => setColorRange((current) => ({
                        ...current,
                        maximum: Math.max(Number(event.target.value), current.minimum + Number.EPSILON),
                      }))}
                    />
                  </label>
                )}
              </>
            )}
            <button
              className="screenshot-button"
              title="Save plot as PNG"
              onClick={() => void savePlotScreenshot(variable.name).catch((error: unknown) => {
                updateStatus(error instanceof Error ? error.message : String(error));
              })}
            >
              Save PNG
            </button>
          </div>
        </div>

        <section className="stage">
          {view === "metadata" ? (
            <MetadataPanel metadata={metadata} variable={variable} />
          ) : (
            <section className="figure">
              <header className="figure-head">
                <h1>{view === "field" ? figureTitle : variableLabel(variable)}</h1>
                <span>{view === "curve" && probePosition ? `at ${probePosition}` : figureSubtitle}</span>
              </header>
              {view === "field" && meshField ? (
                <MeshFieldView
                  key={fieldViewKey}
                  metadata={metadata}
                  variable={fieldVariable}
                  display={display}
                  indices={indices}
                  settled={settled}
                  colormap={colormap}
                  scale={scale}
                  range={colorRange}
                  rangeLocked={rangeLocked}
                  mapSource={mapSource}
                  probe={probe}
                  initialView={fieldViews.current.get(fieldViewKey)}
                  onViewChange={rememberFieldView}
                  onProbe={setProbe}
                  onRange={setColorRange}
                  onFrameLoaded={markFrameLoaded}
                  onStatus={updateStatus}
                />
              ) : view === "field" ? (
                <FieldView
                  key={fieldViewKey}
                  metadata={metadata}
                  variable={fieldVariable}
                  display={display}
                  indices={indices}
                  settled={settled}
                  colormap={colormap}
                  scale={scale}
                  range={colorRange}
                  rangeLocked={rangeLocked}
                  mapSource={mapSource}
                  probe={probe}
                  initialView={fieldViews.current.get(fieldViewKey)}
                  onViewChange={rememberFieldView}
                  onProbe={setProbe}
                  onRange={setColorRange}
                  onFrameLoaded={markFrameLoaded}
                  onStatus={updateStatus}
                />
              ) : (
                <CurveView
                  key={variable.path}
                  metadata={metadata}
                  variable={variable}
                  curveDimension={curveDimension}
                  indices={curveIndices}
                  onFrameLoaded={markFrameLoaded}
                  onStatus={updateStatus}
                />
              )}
            </section>
          )}
        </section>

        <Timeline
          timeline={timeline}
          value={timeline ? indices[timeline.dimension.path] ?? 0 : 0}
          values={timelineValues}
          time={timelineTime}
          playing={playDirection}
          onChange={(value) => timeline && updateIndex(timeline.dimension.path, value)}
          onPlay={setPlayDirection}
        />
      </main>

      <footer className="statusbar">
        <span>{status}</span>
        <span>{shapeText(variable, display)}</span>
        <span>{probePosition ? `${probePosition} · ${formatNumber(probe!.value)} ${variableUnit(variable)}` : "click field to probe"}</span>
      </footer>
    </div>
  );
}

function DatasetBrowser({
  metadata,
  selectedPath,
  search,
  onSearch,
  onSelect,
}: {
  metadata: Metadata;
  selectedPath: string;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (path: string) => void;
}) {
  const [showMeshGeometry, setShowMeshGeometry] = useState(false);
  const query = search.trim().toLowerCase();
  const geometryPaths = useMemo(() => meshGeometryPaths(metadata), [metadata]);
  const visibleCount = metadata.variables.length - (showMeshGeometry ? 0 : geometryPaths.size);
  return (
    <aside className="sidebar">
      <div className="dataset-head">
        <strong>{metadata.dataset.name}</strong>
        <span>{visibleCount} variables</span>
      </div>
      <div className="variable-filter">
        <input
          className="variable-search"
          type="search"
          placeholder="Filter variables"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        {geometryPaths.size > 0 && (
          <label>
            <input
              type="checkbox"
              checked={showMeshGeometry}
              onChange={(event) => setShowMeshGeometry(event.target.checked)}
            />
            Show mesh geometry ({geometryPaths.size})
          </label>
        )}
      </div>
      <div className="tree" role="tree">
        {metadata.groups.map((group) => {
          const variables = metadata.variables.filter((variable) => {
            const parent = variable.path.slice(0, variable.path.lastIndexOf("/")) || "/";
            return (
              parent === group.path &&
              (showMeshGeometry || !geometryPaths.has(variable.path)) &&
              (!query || variable.path.toLowerCase().includes(query))
            );
          });
          if (!variables.length) return null;
          return (
            <details key={group.path} open>
              <summary>{group.path}</summary>
              {variables.map((variable) => (
                <button
                  key={variable.path}
                  className="variable-row"
                  aria-selected={variable.path === selectedPath}
                  onClick={() => onSelect(variable.path)}
                >
                  <span>{variable.name}</span>
                  <small>{variable.dtype} · {variable.dimensions.map((dimension) => dimension.length).join("×") || "scalar"}</small>
                </button>
              ))}
            </details>
          );
        })}
      </div>
      {metadata.warnings.length > 0 && (
        <details className="warnings">
          <summary>{metadata.warnings.length} metadata warning{metadata.warnings.length === 1 ? "" : "s"}</summary>
          {metadata.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </details>
      )}
    </aside>
  );
}

function DimensionSelect({
  variable,
  value,
  onChange,
}: {
  variable: Variable;
  value: number | undefined;
  onChange: (value: number) => void;
}) {
  return (
    <select value={value ?? 0} onChange={(event) => onChange(Number(event.target.value))}>
      {variable.dimensions.map((dimension, index) => (
        <option key={dimension.path} value={index}>{dimension.name} ({dimension.length})</option>
      ))}
    </select>
  );
}

function CoordinateSelect({
  candidates,
  value,
  onChange,
}: {
  candidates: Variable[];
  value: string | undefined;
  onChange: (path: string | undefined) => void;
}) {
  return (
    <select value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)}>
      <option value="">index</option>
      {candidates.map((candidate) => (
        <option key={candidate.path} value={candidate.path}>{candidate.path}</option>
      ))}
    </select>
  );
}

function Timeline({
  timeline,
  value,
  values,
  time,
  playing,
  onChange,
  onPlay,
}: {
  timeline: { dimension: Variable["dimensions"][number]; index: number } | undefined;
  value: number;
  values: Float32Array | undefined;
  time: TimeDescription | undefined;
  playing: -1 | 0 | 1;
  onChange: (value: number) => void;
  onPlay: (direction: -1 | 0 | 1) => void;
}) {
  if (!timeline) return <div className="timeline empty">No indexed dimension</div>;
  const last = Math.max(0, timeline.dimension.length - 1);
  const ticks = time && values ? timelineTickIndices(values.length) : [];
  return (
    <div className="timeline">
      <div className="playback" aria-label="Dimension playback">
        <button title="First sample" onClick={() => { onPlay(0); onChange(0); }}>│◀</button>
        <button title="Play backward" aria-pressed={playing === -1} onClick={() => onPlay(-1)}>◀</button>
        <button title="Stop" aria-pressed={playing === 0} onClick={() => onPlay(0)}>■</button>
        <button title="Play forward" aria-pressed={playing === 1} onClick={() => onPlay(1)}>▶</button>
        <button title="Last sample" onClick={() => { onPlay(0); onChange(last); }}>▶│</button>
      </div>
      <strong>{timeline.dimension.name}</strong>
      <div className="timeline-track">
        <input
          type="range"
          min={0}
          max={last}
          value={value}
          onChange={(event) => { onPlay(0); onChange(Number(event.target.value)); }}
        />
        {ticks.length > 0 && (
          <div className="timeline-fishbone" aria-hidden="true">
            {ticks.map((index) => {
              const label = timeTickLabel(values![index], time!);
              return (
                <span key={index} style={{ left: `${last ? (index / last) * 100 : 0}%` }}>
                  <i />
                  <b className={label.day ? "time-day" : "time-hour"}>{label.primary}</b>
                  {label.month && <em className="time-month">{label.month}</em>}
                </span>
              );
            })}
          </div>
        )}
        {time && <small className="timeline-axis-title">Time ({time.zoneLabel})</small>}
      </div>
      <output>
        {time && values?.[value] !== undefined
          ? formatTimestamp(values[value], time)
          : `${value} / ${last}`}
      </output>
    </div>
  );
}

function fieldTitle(
  variable: Variable,
  dimensionName: string | undefined,
  index: number | undefined,
  coordinate: number | undefined,
  time: TimeDescription | undefined,
) {
  if (time && coordinate !== undefined) return formatTimestamp(coordinate, time);
  return dimensionName?.toLowerCase().includes("time") && index !== undefined
    ? `timestep ${index}`
    : variableLabel(variable);
}

function timelineTickIndices(length: number): number[] {
  if (length <= 9) return Array.from({ length }, (_, index) => index);
  const step = Math.ceil((length - 1) / 8);
  const ticks = Array.from({ length: Math.ceil(length / step) }, (_, index) => index * step);
  if (ticks.at(-1) !== length - 1) ticks.push(length - 1);
  return ticks;
}

function changeDisplayDimension(
  current: DisplayDimensions,
  axis: "x" | "y",
  next: number,
): DisplayDimensions {
  if (axis === "x") {
    return next === current.y ? { x: next, y: current.x } : { ...current, x: next };
  }
  return next === current.x ? { x: current.y, y: next } : { ...current, y: next };
}

function shapeText(variable: Variable, display: DisplayDimensions): string {
  const parts = variable.dimensions.map((dimension, index) =>
    index === display.x ? `x=${dimension.length}` : index === display.y ? `y=${dimension.length}` : String(dimension.length),
  );
  const fixed = parts.filter((_, index) => index !== display.x && index !== display.y);
  const displayed = parts.filter((_, index) => index === display.x || index === display.y);
  return `shape ${[...fixed, displayed.length ? `dim(${displayed.join(",")})` : undefined].filter(Boolean).join(" × ")}`;
}

function hasCompatibleMeshCoordinates(
  metadata: Metadata,
  variable: Variable,
  display: DisplayDimensions,
): boolean {
  const hint = variable.view_hint;
  if (hint.kind === "ugrid2d") return display.x !== undefined;
  if (hint.kind !== "curvilinear" || display.x === undefined || display.y === undefined) return false;
  const coordinate = metadata.variables.find((candidate) => candidate.path === hint.x);
  return Boolean(
    coordinate &&
    coordinate.dimensions.length === 2 &&
    coordinate.dimensions[0].path === variable.dimensions[display.y]?.path &&
    coordinate.dimensions[1].path === variable.dimensions[display.x]?.path,
  );
}

function compatibleCoordinates(
  metadata: Metadata,
  variable: Variable,
  display: DisplayDimensions,
  axis: "x" | "y",
): Variable[] {
  if (display.x === undefined || display.y === undefined) return [];
  const xPath = variable.dimensions[display.x]?.path;
  const yPath = variable.dimensions[display.y]?.path;
  const oneDimensionalPath = axis === "x" ? xPath : yPath;
  return metadata.variables.filter((candidate) => {
    if (candidate.path === variable.path || !isNumeric(candidate)) return false;
    const paths = candidate.dimensions.map((dimension) => dimension.path);
    return (
      (paths.length === 1 && paths[0] === oneDimensionalPath) ||
      (paths.length === 2 && paths[0] === yPath && paths[1] === xPath)
    );
  });
}

function variableWithCoordinates(
  metadata: Metadata,
  variable: Variable,
  display: DisplayDimensions,
  paths: { x?: string; y?: string },
): Variable {
  if (variable.view_hint.kind === "ugrid2d") return variable;
  const x = metadata.variables.find((candidate) => candidate.path === paths.x);
  const y = metadata.variables.find((candidate) => candidate.path === paths.y);
  const xDimension = display.x === undefined ? undefined : variable.dimensions[display.x];
  const yDimension = display.y === undefined ? undefined : variable.dimensions[display.y];
  if (!x || !y || !xDimension || !yDimension || !isNumeric(x) || !isNumeric(y)) {
    return { ...variable, view_hint: { kind: "plain" } };
  }
  const xDimensions = x.dimensions.map((dimension) => dimension.path);
  const yDimensions = y.dimensions.map((dimension) => dimension.path);
  if (
    xDimensions.length === 1 &&
    xDimensions[0] === xDimension.path &&
    yDimensions.length === 1 &&
    yDimensions[0] === yDimension.path
  ) {
    return { ...variable, view_hint: { kind: "rectilinear", x: x.path, y: y.path } };
  }
  const expected = [yDimension.path, xDimension.path];
  if (
    xDimensions.length === 2 &&
    yDimensions.length === 2 &&
    xDimensions.every((path, index) => path === expected[index]) &&
    yDimensions.every((path, index) => path === expected[index])
  ) {
    return { ...variable, view_hint: { kind: "curvilinear", x: x.path, y: y.path } };
  }
  return { ...variable, view_hint: { kind: "plain" } };
}

function hasGeographicCoordinates(metadata: Metadata, variable: Variable): boolean {
  const hint = variable.view_hint;
  if (hint.kind !== "rectilinear" && hint.kind !== "curvilinear" && hint.kind !== "ugrid2d") {
    return false;
  }
  const x = metadata.variables.find((candidate) => candidate.path === hint.x);
  const y = metadata.variables.find((candidate) => candidate.path === hint.y);
  if (!x || !y) return false;
  const xName = attributeText(x, "standard_name");
  const yName = attributeText(y, "standard_name");
  const xUnits = attributeText(x, "units") ?? "";
  const yUnits = attributeText(y, "units") ?? "";
  return (
    (xName === "longitude" || xUnits.startsWith("degrees_east")) &&
    (yName === "latitude" || yUnits.startsWith("degrees_north"))
  );
}

async function savePlotScreenshot(name: string): Promise<void> {
  const sourceCanvas = document.querySelector<HTMLCanvasElement>(".field-canvas, .mesh-canvas");
  const sourceSvg = document.querySelector<SVGSVGElement>(".curve-svg");
  if (!sourceCanvas && !sourceSvg) throw new Error("The current view has no plot to save");

  const bounds = (sourceCanvas ?? sourceSvg!).getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(bounds.width * ratio));
  output.height = Math.max(1, Math.round(bounds.height * ratio));
  const context = output.getContext("2d", { alpha: false });
  if (!context) throw new Error("The browser could not create a screenshot canvas");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, output.width, output.height);

  if (sourceCanvas) {
    context.drawImage(sourceCanvas, 0, 0, output.width, output.height);
  } else if (sourceSvg) {
    const blob = new Blob([new XMLSerializer().serializeToString(sourceSvg)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      context.drawImage(image, 0, 0, output.width, output.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const png = await new Promise<Blob>((resolve, reject) => {
    output.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG export failed")), "image/png");
  });
  const url = URL.createObjectURL(png);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[^a-z0-9._-]+/gi, "_") || "ncx-plot"}.png`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
