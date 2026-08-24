import { useCallback, useEffect, useRef, useState } from "react";

import { fetchCoordinate, fetchMetadata } from "./api";
import {
  fieldComparisonDatasets,
  findCompatibleVariable,
  nearestFrame,
} from "./comparison";
import { FieldView } from "./FieldView";
import { MeshFieldView } from "./MeshFieldView";
import type { ColormapChoice, ColorRange } from "./color";
import type { ColorScale, DatasetSummary, Metadata, Probe, Variable } from "./model";
import { variableLabel } from "./model";
import { defaultDisplayDimensions, defaultIndices, type DisplayDimensions } from "./selection";
import { describeTime, formatTimestamp, timeInZone, type DisplayTimeZone } from "./time";
import type { ViewBounds } from "./view";

interface Pane {
  id: string;
  label: string;
  metadata: Metadata;
  variable: Variable;
  display: DisplayDimensions;
  indices: Record<string, number>;
  timestamp?: string;
  deltaMs?: number;
  unavailable?: string;
}

const ignoreView = () => {};

export function ComparisonFieldView({
  datasets,
  primaryMetadata,
  variable,
  display,
  indices,
  settled,
  colormap,
  scale,
  range,
  rangeLocked,
  mapSource,
  probe,
  timeZone,
  onProbe,
  onRange,
  onFrameLoaded,
  onStatus,
}: {
  datasets: DatasetSummary[];
  primaryMetadata: Metadata;
  variable: Variable;
  display: DisplayDimensions;
  indices: Record<string, number>;
  settled: boolean;
  colormap: ColormapChoice;
  scale: ColorScale;
  range: ColorRange;
  rangeLocked: boolean;
  mapSource: "none" | "osm";
  probe: Probe | undefined;
  timeZone: DisplayTimeZone;
  onProbe: (probe: Probe) => void;
  onRange: (range: ColorRange) => void;
  onFrameLoaded: () => void;
  onStatus: (status: string) => void;
}) {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<ViewBounds>();
  const [paneRanges, setPaneRanges] = useState<Record<string, ColorRange>>({});
  const [paneVersion, setPaneVersion] = useState(0);
  const requestedVersion = useRef(0);
  const loadedPanes = useRef(new Set<string>());
  const frameComplete = useRef(false);

  useEffect(() => {
    let active = true;
    const version = ++requestedVersion.current;
    loadedPanes.current.clear();
    frameComplete.current = false;
    void loadPanes(
      fieldComparisonDatasets(datasets, primaryMetadata.dataset_id),
      primaryMetadata,
      variable,
      display,
      indices,
      timeZone,
    )
      .then((next) => {
        if (!active) return;
        setPanes(next);
        setPaneVersion(version);
        setPaneRanges({});
        setError(undefined);
        onStatus(`${next.filter((pane) => !pane.unavailable).length} synchronized field panes`);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        onStatus(message);
      });
    return () => {
      active = false;
    };
  }, [datasets, primaryMetadata, variable, display, indices, timeZone, onStatus]);

  useEffect(() => {
    if (rangeLocked) return;
    const values = Object.values(paneRanges);
    if (!values.length) return;
    onRange({
      minimum: Math.min(...values.map((item) => item.minimum)),
      maximum: Math.max(...values.map((item) => item.maximum)),
    });
  }, [paneRanges, rangeLocked, onRange]);

  const recordRange = useCallback((id: string, next: ColorRange) => {
    setPaneRanges((current) => {
      const previous = current[id];
      return previous?.minimum === next.minimum && previous.maximum === next.maximum
        ? current
        : { ...current, [id]: next };
    });
  }, []);
  const recordFrameLoaded = useCallback((id: string) => {
    if (paneVersion !== requestedVersion.current || frameComplete.current) return;
    loadedPanes.current.add(id);
    const expected = panes.filter((pane) => !pane.unavailable);
    if (expected.length && expected.every((pane) => loadedPanes.current.has(pane.id))) {
      frameComplete.current = true;
      onFrameLoaded();
    }
  }, [paneVersion, panes, onFrameLoaded]);
  const selectedCount = fieldComparisonDatasets(datasets, primaryMetadata.dataset_id).length;
  return (
    <section className="figure comparison-field-figure">
      <header className="figure-head">
        <h1>{variableLabel(variable)} fields</h1>
        <span>{panes.filter((pane) => !pane.unavailable).length} / {selectedCount} panes · shared range</span>
      </header>
      <div className="field-comparison" data-count={panes.length}>
        {panes.map((pane) => (
          <ComparisonPane
            key={pane.id}
            pane={pane}
            settled={settled}
            colormap={colormap}
            scale={scale}
            range={range}
            rangeLocked={rangeLocked}
            mapSource={mapSource}
            probe={probe}
            controlledView={view}
            onViewChange={setView}
            onProbe={onProbe}
            onRange={recordRange}
            onFrameLoaded={recordFrameLoaded}
            onStatus={onStatus}
          />
        ))}
        {!panes.length && !error && <span className="plot-loading">opening comparison fields…</span>}
        {error && <div className="plot-error">{error}</div>}
      </div>
      {datasets.length > selectedCount && (
        <span className="comparison-warning field-limit">
          Fields show {selectedCount} of {datasets.length} sources.
        </span>
      )}
    </section>
  );
}

function ComparisonPane({
  pane,
  settled,
  colormap,
  scale,
  range,
  rangeLocked,
  mapSource,
  probe,
  controlledView,
  onViewChange,
  onProbe,
  onRange,
  onFrameLoaded,
  onStatus,
}: {
  pane: Pane;
  settled: boolean;
  colormap: ColormapChoice;
  scale: ColorScale;
  range: ColorRange;
  rangeLocked: boolean;
  mapSource: "none" | "osm";
  probe: Probe | undefined;
  controlledView?: ViewBounds;
  onViewChange: (view: ViewBounds) => void;
  onProbe: (probe: Probe) => void;
  onRange: (id: string, range: ColorRange) => void;
  onFrameLoaded: (id: string) => void;
  onStatus: (status: string) => void;
}) {
  const reportRange = useCallback((next: ColorRange) => onRange(pane.id, next), [onRange, pane.id]);
  const reportFrameLoaded = useCallback(() => onFrameLoaded(pane.id), [onFrameLoaded, pane.id]);
  const common = {
    metadata: pane.metadata,
    variable: pane.variable,
    display: pane.display,
    indices: pane.indices,
    settled,
    colormap,
    scale,
    range,
    rangeLocked,
    sharedRange: true,
    mapSource,
    probe,
    onProbe,
    onRange: reportRange,
    onFrameLoaded: reportFrameLoaded,
    onStatus,
  };
  return (
    <article className="field-comparison-pane">
      <header>
        <strong>{pane.label}</strong>
        <span>{pane.unavailable ?? [pane.timestamp, deltaText(pane.deltaMs)].filter(Boolean).join(" · ")}</span>
      </header>
      {pane.unavailable
        ? <div className="comparison-unavailable">{pane.unavailable}</div>
        : isMesh(pane.variable)
          ? <MeshFieldView {...common} controlledView={controlledView} onViewChange={onViewChange} />
          : <FieldView
              {...common}
              controlledWorldView={controlledView}
              onWorldViewChange={onViewChange}
              onViewChange={ignoreView}
            />}
    </article>
  );
}

async function loadPanes(
  datasets: DatasetSummary[],
  primaryMetadata: Metadata,
  reference: Variable,
  referenceDisplay: DisplayDimensions,
  referenceIndices: Record<string, number>,
  timeZone: DisplayTimeZone,
): Promise<Pane[]> {
  const loaded = await Promise.all(datasets.map(async (dataset) => ({
    dataset,
    metadata: dataset.id === primaryMetadata.dataset_id ? primaryMetadata : await fetchMetadata(dataset.id),
  })));
  const primaryAxis = await fieldTimeAxis(primaryMetadata, reference);
  const primaryIndex = primaryAxis
    ? clampIndex(referenceIndices[primaryAxis.dimension.path], primaryAxis.values.length)
    : undefined;
  const targetMs = primaryAxis && primaryIndex !== undefined ? primaryAxis.epochMs[primaryIndex] : undefined;
  const panes: Pane[] = [];
  for (const { dataset, metadata } of loaded) {
    const match = dataset.id === primaryMetadata.dataset_id
      ? { variable: reference }
      : findCompatibleVariable(reference, metadata);
    if (!match || match.variable.dimensions.length < 2) {
      panes.push(unavailablePane(dataset, metadata, reference, "No compatible field"));
      continue;
    }
    const variable = match.variable;
    const display = mappedDisplay(reference, referenceDisplay, variable);
    const indices = mappedIndices(reference, referenceIndices, variable);
    const axis = await fieldTimeAxis(metadata, variable);
    let timestamp: string | undefined;
    let deltaMs: number | undefined;
    if (targetMs !== undefined) {
      if (!axis) {
        panes.push(unavailablePane(dataset, metadata, variable, "No decodable absolute time axis", display, indices));
        continue;
      }
      const frame = nearestFrame(targetMs, axis.epochMs);
      if (!frame) {
        panes.push(unavailablePane(dataset, metadata, variable, "No frame within tolerance", display, indices));
        continue;
      }
      indices[axis.dimension.path] = frame.index;
      deltaMs = frame.deltaMs;
      timestamp = formatTimestamp(axis.values[frame.index], timeInZone(axis.time, timeZone)!);
    } else if (axis) {
      panes.push(unavailablePane(dataset, metadata, variable, "Primary field has no comparable absolute time", display, indices));
      continue;
    }
    panes.push({ id: dataset.id, label: dataset.label, metadata, variable, display, indices, timestamp, deltaMs });
  }
  return panes;
}

async function fieldTimeAxis(metadata: Metadata, variable: Variable) {
  for (const dimension of variable.dimensions) {
    const coordinate = metadata.variables.find((candidate) =>
      candidate.path === dimension.path && candidate.dimensions.length === 1,
    );
    const time = describeTime(coordinate);
    if (!coordinate || !time) continue;
    const values = await fetchCoordinate(coordinate);
    return {
      dimension,
      values,
      time,
      epochMs: Array.from(values, (value) => time.originMs + value * time.multiplierMs),
    };
  }
  return undefined;
}

function mappedDisplay(reference: Variable, display: DisplayDimensions, variable: Variable): DisplayDimensions {
  const xName = display.x === undefined ? undefined : reference.dimensions[display.x]?.name;
  const yName = display.y === undefined ? undefined : reference.dimensions[display.y]?.name;
  const x = xName === undefined ? -1 : variable.dimensions.findIndex((dimension) => dimension.name === xName);
  const y = yName === undefined ? -1 : variable.dimensions.findIndex((dimension) => dimension.name === yName);
  return x >= 0 && y >= 0 && x !== y ? { x, y } : defaultDisplayDimensions(variable);
}

function mappedIndices(
  reference: Variable,
  referenceIndices: Record<string, number>,
  variable: Variable,
): Record<string, number> {
  const result = defaultIndices(variable);
  for (const dimension of variable.dimensions) {
    const source = reference.dimensions.find((candidate) => candidate.name === dimension.name);
    if (source) result[dimension.path] = clampIndex(referenceIndices[source.path], dimension.length);
  }
  return result;
}

function clampIndex(value: number | undefined, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.round(value ?? 0)));
}

function unavailablePane(
  dataset: DatasetSummary,
  metadata: Metadata,
  variable: Variable,
  unavailable: string,
  display = defaultDisplayDimensions(variable),
  indices = defaultIndices(variable),
): Pane {
  return { id: dataset.id, label: dataset.label, metadata, variable, display, indices, unavailable };
}

function isMesh(variable: Variable): boolean {
  return variable.view_hint.kind === "curvilinear" || variable.view_hint.kind === "ugrid2d";
}

function deltaText(deltaMs: number | undefined): string | undefined {
  if (deltaMs === undefined) return undefined;
  const minutes = deltaMs / 60_000;
  return `Δ ${minutes > 0 ? "+" : ""}${minutes.toFixed(Math.abs(minutes) < 10 ? 1 : 0)} min`;
}
