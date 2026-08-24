import { useEffect, useMemo, useState } from "react";

import { fetchCoordinate, fetchMetadata, fetchSlice } from "./api";
import { findCompatibleVariable, locationIdentity, verticalDatum } from "./comparison";
import { CurveAxes, curveGeometry, sharedCurveDomain } from "./CurveView";
import type { DatasetSummary, Metadata, Variable } from "./model";
import { attributeText, displayUnit, quantityLabel, variableLabel } from "./model";
import { curveRequest, defaultCurveDimension, defaultIndices } from "./selection";
import { describeTime, timeInZone, type DisplayTimeZone, type TimeDescription } from "./time";
import { useElementSize } from "./useElementSize";

const SERIES_COLORS = ["#011959", "#B58E30", "#4D734D", "#114160", "#747E38", "#1E5D62"];
const SERIES_DASHES = ["none", "7 3", "2 2", "9 3 2 3", "12 3", "2 3 8 3"];

interface Series {
  id: string;
  label: string;
  variable: Variable;
  basis: "CF" | "name";
  x: Float64Array;
  y: Float32Array;
  xUnit: string;
  absoluteTime: boolean;
  datum?: string;
  quantity?: string;
  locationId?: string;
}

interface Offset {
  xMinutes: number;
  y: number;
}

export function ComparisonCurveView({
  datasets,
  primaryMetadata,
  variable,
  indices,
  timeZone,
  onStatus,
}: {
  datasets: DatasetSummary[];
  primaryMetadata: Metadata;
  variable: Variable;
  indices: Record<string, number>;
  timeZone: DisplayTimeZone;
  onStatus: (status: string) => void;
}) {
  const [frame, size] = useElementSize<HTMLDivElement>();
  const [series, setSeries] = useState<Series[]>([]);
  const [omissions, setOmissions] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [offsets, setOffsets] = useState<Record<string, Offset>>({});

  useEffect(() => {
    let active = true;
    setSeries([]);
    setOmissions([]);
    setError(undefined);
    const selected = datasets.slice(0, 6);
    void Promise.all(selected.map(async (dataset) => ({
      dataset,
      metadata: dataset.id === primaryMetadata.dataset_id
        ? primaryMetadata
        : await fetchMetadata(dataset.id),
    })))
      .then(async (loaded) => {
        const missing: string[] = [];
        const matched = loaded.flatMap(({ dataset, metadata }) => {
          const match = dataset.id === primaryMetadata.dataset_id
            ? { variable, basis: attributeText(variable, "standard_name") ? "CF" as const : "name" as const }
            : findCompatibleVariable(variable, metadata);
          if (!match || match.variable.dimensions.length === 0) {
            missing.push(`${dataset.label}: no compatible curve`);
            return [];
          }
          return [{ dataset, metadata, ...match }];
        });
        const next = await Promise.all(matched.map(({ dataset, metadata, variable: candidate, basis }) =>
          loadSeries(dataset, metadata, candidate, basis, variable, indices),
        ));
        const primary = next.find((item) => item.id === primaryMetadata.dataset_id) ?? next[0];
        const ordered = primary
          ? [primary, ...next.filter((item) => item !== primary)]
          : [];
        const compatible = primary
          ? ordered.filter((item) => {
              const sameAxis = item.absoluteTime === primary.absoluteTime &&
                (item.absoluteTime || item.xUnit === primary.xUnit);
              if (!sameAxis) missing.push(`${item.label}: incompatible x coordinate`);
              return sameAxis;
            })
          : [];
        if (!active) return;
        setSeries(compatible);
        setOmissions(missing);
        setError(undefined);
        onStatus(`${compatible.length} compatible comparison series`);
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
  }, [datasets, primaryMetadata, variable, indices, onStatus]);

  useEffect(() => {
    setOffsets({});
  }, [datasets, indices, primaryMetadata.dataset_id, variable.dataset_id, variable.path]);

  const loadedPrimary = series.find((item) => item.id === primaryMetadata.dataset_id);
  const currentSeries = loadedPrimary?.variable.dataset_id === variable.dataset_id
    && loadedPrimary?.variable.path === variable.path
    ? series
    : [];
  const styled = useMemo(() => currentSeries.map((item, index) => ({
    ...item,
    color: SERIES_COLORS[index],
    dash: SERIES_DASHES[index],
  })), [currentSeries]);
  const adjusted = useMemo(() => styled.map((item) => {
    const offset = offsets[item.id] ?? { xMinutes: 0, y: 0 };
    return {
      ...item,
      x: item.absoluteTime
        ? Float64Array.from(item.x, (value) => value + offset.xMinutes * 60_000)
        : item.x,
      y: Float32Array.from(item.y, (value) => value + offset.y),
      offset,
    };
  }), [styled, offsets]);
  const domain = useMemo(() => sharedCurveDomain(adjusted), [adjusted]);
  const geometries = adjusted.map((item) => ({
    item,
    geometry: domain ? curveGeometry(item.y, item.x, size.width, size.height, domain) : undefined,
  }));
  const time: TimeDescription | undefined = adjusted[0]?.absoluteTime
    ? timeInZone({ multiplierMs: 1, originMs: 0, offsetMinutes: 0, zoneLabel: "UTC" }, timeZone)
    : undefined;
  const hasXOffset = styled.some(
    (item) => item.absoluteTime && (offsets[item.id]?.xMinutes ?? 0) !== 0,
  );
  const hasYOffset = Object.values(offsets).some((offset) => offset.y !== 0);

  return (
    <section className="figure comparison-figure">
      <header className="figure-head">
        <h1>{variableLabel(variable)} comparison</h1>
        <span>{adjusted.length} visible series · {displayUnit(variable)}</span>
      </header>
      <div className="comparison-controls">
        {styled.map((item) => {
          const offset = offsets[item.id] ?? { xMinutes: 0, y: 0 };
          return (
            <div className="series-control" key={item.id}>
              <svg className="series-key" viewBox="0 0 18 4" aria-hidden="true">
                <line x1="0" y1="2" x2="18" y2="2" style={{
                  stroke: item.color,
                  strokeDasharray: item.dash,
                }} />
              </svg>
              <strong>{item.label}</strong>
              <span>{displayUnit(item.variable)} {item.datum ?? "datum unspecified"} · {item.quantity ?? item.basis}{item.locationId ? ` · ${item.locationId}` : ""}</span>
              {item.absoluteTime && (
                <label>X offset [min]
                  <input type="number" step="any" value={offset.xMinutes} onChange={(event) =>
                    setOffsets((current) => ({ ...current, [item.id]: { ...offset, xMinutes: finiteInput(event.currentTarget) } }))
                  } />
                </label>
              )}
              <label>Y offset [{displayUnit(item.variable) || "1"}]
                <input type="number" step="any" value={offset.y} onChange={(event) =>
                  setOffsets((current) => ({ ...current, [item.id]: { ...offset, y: finiteInput(event.currentTarget) } }))
                } />
              </label>
            </div>
          );
        })}
        <button onClick={() => setOffsets({})}>Reset offsets</button>
        {omissions.length > 0 && <span className="comparison-warning">{omissions.join(" · ")}</span>}
      </div>
      <div className="plot-frame curve-frame" ref={frame}>
        <svg className="curve-svg" width={size.width} height={size.height} aria-label={`${variableLabel(variable)} comparison`}>
          {geometries[0]?.geometry && (
            <CurveAxes
              geometry={geometries[0].geometry}
              dimension={time ? "time" : geometries[0].item.xUnit || "index"}
              time={time}
              timeNote={hasXOffset ? "display offsets" : undefined}
              valueLabel={`${quantityLabel(variable)}${hasYOffset ? "; display offsets" : ""}`}
            />
          )}
          {geometries.map(({ item, geometry }) => geometry && (
            <path
              key={item.id}
              className="curve-line comparison-line"
              style={{ stroke: item.color, strokeDasharray: item.dash }}
              d={geometry.path}
            />
          ))}
        </svg>
        {!currentSeries.length && !error && (
          <span className="plot-loading">reading comparison curves…</span>
        )}
        {error && <div className="plot-error">{error}</div>}
      </div>
    </section>
  );
}

async function loadSeries(
  dataset: DatasetSummary,
  metadata: Metadata,
  variable: Variable,
  basis: "CF" | "name",
  reference: Variable,
  referenceIndices: Record<string, number>,
): Promise<Series> {
  const timeDimension = variable.dimensions.findIndex((dimension) => {
    const coordinate = metadata.variables.find((candidate) => candidate.path === dimension.path);
    return describeTime(coordinate) !== undefined;
  });
  const curveDimension = defaultCurveDimension(variable, undefined, (path) => {
    const coordinate = metadata.variables.find((candidate) => candidate.path === path);
    return describeTime(coordinate) !== undefined;
  });
  const indices = defaultIndices(variable);
  for (const dimension of variable.dimensions) {
    const source = reference.dimensions.find((candidate) => candidate.name === dimension.name);
    if (source && referenceIndices[source.path] !== undefined) {
      indices[dimension.path] = referenceIndices[source.path];
    }
  }
  const dimension = variable.dimensions[timeDimension >= 0 ? timeDimension : curveDimension];
  const coordinate = metadata.variables.find((candidate) =>
    candidate.path === dimension.path && candidate.dimensions.length === 1,
  );
  const [slice, coordinateValues] = await Promise.all([
    fetchSlice(curveRequest(variable, timeDimension >= 0 ? timeDimension : curveDimension, indices)),
    coordinate ? fetchCoordinate(coordinate) : undefined,
  ]);
  const y = Float32Array.from(slice.values, Number);
  const rawX = coordinateValues?.length === y.length
    ? coordinateValues
    : Float32Array.from({ length: y.length }, (_, index) => index);
  const time = describeTime(coordinate);
  return {
    id: dataset.id,
    label: dataset.label,
    variable,
    basis,
    x: time
      ? Float64Array.from(rawX, (value) => time.originMs + value * time.multiplierMs)
      : Float64Array.from(rawX),
    y,
    xUnit: time
      ? "epoch milliseconds"
      : coordinate ? attributeText(coordinate, "units") ?? dimension.name : dimension.name,
    absoluteTime: Boolean(time),
    datum: verticalDatum(variable),
    quantity: attributeText(variable, "standard_name"),
    locationId: locationIdentity(variable),
  };
}

function finiteInput(input: HTMLInputElement): number {
  return Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : 0;
}
