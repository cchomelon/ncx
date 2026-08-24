import type { ComparisonSeries, DatasetSummary, Metadata, Variable } from "./model.ts";
import { attributeText } from "./model.ts";

export interface VariableMatch {
  variable: Variable;
  basis: "CF" | "name";
}

export function primaryFirst(
  datasets: readonly DatasetSummary[],
  primaryId: string | undefined,
): DatasetSummary[] {
  const primary = datasets.find((dataset) => dataset.id === primaryId);
  return primary
    ? [primary, ...datasets.filter((dataset) => dataset !== primary)]
    : [...datasets];
}

export function fieldComparisonDatasets(
  datasets: readonly DatasetSummary[],
  primaryId: string | undefined,
): DatasetSummary[] {
  const ordered = primaryFirst(datasets, primaryId);
  return ordered.slice(0, ordered.length >= 4 ? 4 : Math.min(2, ordered.length));
}

export function comparisonAvailable(
  dimensions: number,
  datasets: number,
): boolean {
  return dimensions > 0 && datasets >= 2;
}

/** Find the same physical quantity without guessing across units or stations. */
export function findCompatibleVariable(
  reference: Variable,
  metadata: Metadata,
): VariableMatch | undefined {
  const referenceStandard = attributeText(reference, "standard_name");
  const referenceUnits = attributeText(reference, "units")?.trim() ?? "";
  const referenceLocation = locationIdentity(reference);
  const candidates = metadata.variables.filter((candidate) => {
    if ((attributeText(candidate, "units")?.trim() ?? "") !== referenceUnits) return false;
    const candidateStandard = attributeText(candidate, "standard_name");
    if (referenceStandard
      ? candidateStandard !== referenceStandard
      : candidateStandard || (candidate.path !== reference.path && candidate.name !== reference.name)) {
      return false;
    }
    const candidateLocation = locationIdentity(candidate);
    return !referenceLocation && !candidateLocation || referenceLocation === candidateLocation;
  });
  const variable = candidates.find((candidate) => candidate.path === reference.path) ?? candidates[0];
  if (!variable) return undefined;
  return { variable, basis: referenceStandard ? "CF" : "name" };
}

export function locationIdentity(variable: Variable): string | undefined {
  for (const name of ["station_id", "location_id", "site_id"]) {
    const value = attributeText(variable, name)?.trim();
    if (value) return value;
  }
  return undefined;
}

export function verticalDatum(variable: Variable): string | undefined {
  for (const name of ["vertical_datum", "datum", "reference_datum"]) {
    const value = attributeText(variable, name)?.trim();
    if (value) return value;
  }
  return undefined;
}

export function findComparisonSeries(
  series: readonly ComparisonSeries[],
  locationId: string,
  quantity: string,
  units: string,
): ComparisonSeries | undefined {
  return series.find((item) =>
    item.location_id === locationId && item.quantity === quantity && item.y_units === units
  );
}

export async function requestHostComparison(request: {
  generation: number;
  location_id: string;
  quantity: string;
  units: string;
  start_ms: number;
  end_ms: number;
}): Promise<ComparisonSeries[]> {
  if (window.parent === window) throw new Error("Comparison host is unavailable");
  const requestId = crypto.randomUUID();
  const origin = window.location.origin;
  return new Promise<ComparisonSeries[]>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish("Comparison host timed out"), 60_000);
    const receive = (event: MessageEvent) => {
      const reply = event.data as Record<string, unknown> | null;
      if (
        event.origin !== origin
        || event.source !== window.parent
        || reply?.type !== "ncx:comparison-ready"
        || reply.request_id !== requestId
        || reply.generation !== request.generation
      ) return;
      finish(typeof reply.error === "string" ? reply.error : undefined, reply.series);
    };
    const finish = (error?: string, series?: unknown) => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      if (error) reject(new Error(error));
      else {
        try { resolve(validateComparisonSeries(series)); }
        catch (cause) { reject(cause); }
      }
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({
      type: "ncx:comparison-request",
      request_id: requestId,
      ...request,
    }, origin);
  });
}

function validateComparisonSeries(value: unknown): ComparisonSeries[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new Error("Comparison input must contain one to six series");
  }
  let samples = 0;
  const result = Array.from(value, (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Comparison series must be an object");
    }
    const source = item as Record<string, unknown>;
    const strings = ["id", "label", "quantity", "location_id", "x_units", "y_units"] as const;
    for (const name of strings) {
      if (typeof source[name] !== "string" || source[name].length < 1 || source[name].length > 256) {
        throw new Error(`Comparison ${name} is invalid`);
      }
    }
    if (source.x_units !== "milliseconds since 1970-01-01T00:00:00Z") {
      throw new Error("Comparison x_units are unsupported");
    }
    if (!Array.isArray(source.x) || !Array.isArray(source.y) ||
        source.x.length === 0 || source.x.length !== source.y.length) {
      throw new Error("Comparison x and y must have equal non-zero length");
    }
    if (source.x.length > 100_000 - samples) {
      throw new Error("Comparison input has too many samples");
    }
    const x = Array.from(source.x);
    const y = Array.from(source.y);
    samples += x.length;
    if (x.some((number, index) =>
      !Number.isSafeInteger(number) || Math.abs(number) > 8_640_000_000_000_000 ||
      index > 0 && number <= x[index - 1]) ||
      y.some((number) => typeof number !== "number" || !Number.isFinite(number) ||
        Math.abs(number) > 3.4028235e38)) {
      throw new Error("Comparison values are invalid");
    }
    if (source.vertical_datum !== undefined &&
        (typeof source.vertical_datum !== "string" || source.vertical_datum.length < 1 ||
          source.vertical_datum.length > 256)) {
      throw new Error("Comparison vertical_datum is invalid");
    }
    if (source.primary_y_offset !== undefined &&
        (typeof source.primary_y_offset !== "number" ||
          !Number.isFinite(source.primary_y_offset) || source.primary_y_offset === 0 ||
          Math.abs(source.primary_y_offset) > 3.4028235e38 || !source.vertical_datum)) {
      throw new Error("Comparison primary_y_offset is invalid");
    }
    return { ...source, x, y } as unknown as ComparisonSeries;
  });
  if (new Set(result.map((item) => item.id)).size !== result.length) {
    throw new Error("Comparison IDs must be unique");
  }
  return result;
}

export interface FrameMatch {
  index: number;
  deltaMs: number;
  toleranceMs: number;
}

/** Nearest timestamp, accepted only inside half of its local source step. */
export function nearestFrame(targetMs: number, timestampsMs: readonly number[]): FrameMatch | undefined {
  if (!Number.isFinite(targetMs) || timestampsMs.length === 0) return undefined;
  for (let index = 0; index < timestampsMs.length; index += 1) {
    if (!Number.isFinite(timestampsMs[index]) || (index && timestampsMs[index] <= timestampsMs[index - 1])) {
      return undefined;
    }
  }
  let low = 0;
  let high = timestampsMs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timestampsMs[middle] < targetMs) low = middle + 1;
    else high = middle;
  }
  const index = low === 0
    ? 0
    : low === timestampsMs.length
      ? timestampsMs.length - 1
      : targetMs - timestampsMs[low - 1] <= timestampsMs[low] - targetMs ? low - 1 : low;
  const adjacent = [
    index > 0 ? timestampsMs[index] - timestampsMs[index - 1] : Number.POSITIVE_INFINITY,
    index + 1 < timestampsMs.length ? timestampsMs[index + 1] - timestampsMs[index] : Number.POSITIVE_INFINITY,
  ];
  const localStep = Math.min(...adjacent);
  const toleranceMs = Number.isFinite(localStep) ? localStep / 2 : 0;
  const deltaMs = timestampsMs[index] - targetMs;
  return Math.abs(deltaMs) <= toleranceMs ? { index, deltaMs, toleranceMs } : undefined;
}
