import assert from "node:assert/strict";
import test from "node:test";

import {
  comparisonAvailable,
  fieldComparisonDatasets,
  findComparisonSeries,
  findCompatibleVariable,
  nearestFrame,
  locationIdentity,
  requestHostComparison,
} from "./comparison.ts";
import type { ComparisonSeries, DatasetSummary, Metadata, Variable } from "./model.ts";

function variable(name: string, standardName?: string): Variable {
  return {
    path: `/${name}`,
    name,
    dtype: "f32",
    dimensions: [{ path: "/time", name: "time", length: 3 }],
    attributes: [
      ...(standardName ? [{ name: "standard_name", dtype: "string", value: standardName }] : []),
      { name: "units", dtype: "string", value: "m" },
    ],
    view_hint: { kind: "plain" },
  };
}

function metadata(...variables: Variable[]): Metadata {
  return { variables } as Metadata;
}

function atStation(value: Variable, station: string): Variable {
  return {
    ...value,
    attributes: [
      ...value.attributes,
      { name: "station_id", dtype: "string", value: station },
    ],
  };
}

test("comparison matches CF meaning and refuses a different station", () => {
  const reference = atStation(
    variable("TPK", "sea_surface_height_above_mean_sea_level"),
    "TPK",
  );
  assert.equal(findCompatibleVariable(reference, metadata(atStation(
    variable("TPK", "sea_surface_height_above_mean_sea_level"),
    "TPK",
  )))?.basis, "CF");
  assert.equal(findCompatibleVariable(reference, metadata(atStation(
    variable("QUB", "sea_surface_height_above_mean_sea_level"),
    "QUB",
  ))), undefined);
  assert.equal(findCompatibleVariable(reference, metadata({
    ...variable("TPK", "sea_surface_height_above_mean_sea_level"),
    attributes: [{ name: "units", dtype: "string", value: "cm" }],
  })), undefined);
});

test("location identity comes only from explicit generic metadata", () => {
  assert.equal(locationIdentity(variable("TPK")), undefined);
  assert.equal(locationIdentity({
    ...variable("water"),
    attributes: [
      { name: "units", dtype: "string", value: "m" },
      { name: "location_id", dtype: "string", value: "station-hk-01" },
    ],
  }), "station-hk-01");
});

test("comparison says when a match is name-based", () => {
  assert.equal(findCompatibleVariable(variable("zeta"), metadata(variable("zeta")))?.basis, "name");
});

test("nearest frames use time and a half-local-step tolerance", () => {
  const times = [0, 3_600_000, 7_200_000];
  assert.deepEqual(nearestFrame(5_000_000, times), {
    index: 1,
    deltaMs: -1_400_000,
    toleranceMs: 1_800_000,
  });
  assert.equal(nearestFrame(10_000_001, times), undefined);
  assert.equal(nearestFrame(0, [0, 0]), undefined);
});

test("field comparison uses two or four panes and keeps the primary", () => {
  const datasets = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })) as DatasetSummary[];
  assert.deepEqual(
    fieldComparisonDatasets(datasets.slice(0, 3), "c").map((item) => item.id),
    ["c", "a"],
  );
  assert.deepEqual(
    fieldComparisonDatasets(datasets, "f").map((item) => item.id),
    ["f", "a", "b", "c"],
  );
});

test("comparison requires multiple datasets", () => {
  assert.equal(comparisonAvailable(0, 2), false);
  assert.equal(comparisonAvailable(1, 1), false);
  assert.equal(comparisonAvailable(2, 1), false);
  assert.equal(comparisonAvailable(2, 2), true);
});

test("hosted comparisons match exact location, CF quantity, and units", () => {
  const series = [{
    id: "reference:station-01",
    label: "Station 01 reference",
    quantity: "sea_surface_height_above_mean_sea_level",
    location_id: "station-01",
    x_units: "milliseconds since 1970-01-01T00:00:00Z",
    x: [1, 2],
    y_units: "m",
    vertical_datum: "CD",
    y: [0.1, 0.2],
  }] as ComparisonSeries[];
  assert.equal(findComparisonSeries(
    series,
    "station-01",
    "sea_surface_height_above_mean_sea_level",
    "m",
  )?.id, "reference:station-01");
  assert.equal(findComparisonSeries(series, "station-02", "air_pressure", "Pa"), undefined);
});

test("a hosted request accepts only its parent's matching reply", async () => {
  const host = globalThis as typeof globalThis & { window?: Window & typeof globalThis };
  const previous = host.window;
  const origin = "https://viewer.example";
  let receive: ((event: MessageEvent) => void) | undefined;
  let posted: Record<string, unknown> | undefined;
  let responseSeries = [{
    id: "reference:station-01",
    label: "Station 01 reference",
    quantity: "air_pressure",
    location_id: "station-01",
    x_units: "milliseconds since 1970-01-01T00:00:00Z",
    x: [1, 2],
    y_units: "Pa",
    vertical_datum: "CD",
    primary_y_offset: 1.45,
    y: [1000, 1001],
  }];
  const parent = {
    postMessage(message: Record<string, unknown>) {
      posted = message;
      queueMicrotask(() => receive?.({
        origin,
        source: parent,
        data: {
          type: "ncx:comparison-ready",
          request_id: message.request_id,
          generation: message.generation,
          series: responseSeries,
        },
      } as unknown as MessageEvent));
    },
  };
  host.window = {
    parent,
    location: { origin },
    setTimeout,
    clearTimeout,
    addEventListener(_type: string, listener: EventListener) {
      receive = listener as (event: MessageEvent) => void;
    },
    removeEventListener() {},
  } as unknown as Window & typeof globalThis;
  try {
    const result = await requestHostComparison({
      generation: 3,
      location_id: "station-01",
      quantity: "air_pressure",
      units: "Pa",
      start_ms: 1,
      end_ms: 2,
    });
    assert.equal(posted?.type, "ncx:comparison-request");
    assert.equal(posted?.location_id, "station-01");
    assert.equal(result[0].id, "reference:station-01");
    assert.equal(result[0].primary_y_offset, 1.45);
    responseSeries = [{ ...responseSeries[0], y: Array(2) }];
    await assert.rejects(requestHostComparison({
      generation: 3,
      location_id: "station-01",
      quantity: "air_pressure",
      units: "Pa",
      start_ms: 1,
      end_ms: 2,
    }), /values/);
    responseSeries = [{ ...responseSeries[0], y: [1000, 1001], primary_y_offset: Infinity }];
    await assert.rejects(requestHostComparison({
      generation: 3,
      location_id: "station-01",
      quantity: "air_pressure",
      units: "Pa",
      start_ms: 1,
      end_ms: 2,
    }), /primary_y_offset/);
  } finally {
    if (previous) host.window = previous;
    else delete host.window;
  }
});
