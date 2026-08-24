import type {
  DatasetSummary,
  DataSlice,
  Metadata,
  SliceRequest,
  Variable,
} from "./model";

const staticSliceCache = new Map<string, Promise<DataSlice>>();
const metadataCache = new Map<string, Promise<Metadata>>();
const apiRoot = new URL("api/", document.baseURI);
const viewerGeneration = new URL(document.baseURI).searchParams.get("generation");

function apiUrl(path: string): URL {
  const url = new URL(path, apiRoot);
  if (viewerGeneration) url.searchParams.set("generation", viewerGeneration);
  return url;
}

export async function fetchDatasets(): Promise<{ datasets: DatasetSummary[]; collection: boolean }> {
  const response = await fetch(apiUrl("datasets"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  const body = (await response.json()) as { datasets?: DatasetSummary[]; collection?: boolean };
  if (!Array.isArray(body.datasets) || body.datasets.length === 0) {
    throw new Error("ncx returned no datasets");
  }
  return { datasets: body.datasets, collection: body.collection === true };
}

export async function fetchMetadata(dataset?: string): Promise<Metadata> {
  const key = dataset ?? "";
  const cached = metadataCache.get(key);
  if (cached) return cached;
  const pending = loadMetadata(dataset).catch((error) => {
    metadataCache.delete(key);
    throw error;
  });
  metadataCache.set(key, pending);
  return pending;
}

async function loadMetadata(dataset?: string): Promise<Metadata> {
  const query = new URLSearchParams();
  if (dataset) query.set("dataset", dataset);
  const response = await fetch(apiUrl(`meta${query.size ? `?${query}` : ""}`), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  const metadata = (await response.json()) as Metadata;
  metadata.dataset_id ||= dataset ?? "dataset";
  metadata.dataset_label ||= metadata.dataset_id;
  metadata.variables = metadata.variables.map((variable) => ({
    ...variable,
    dataset_id: metadata.dataset_id,
  }));
  return metadata;
}

export async function fetchSlice(request: SliceRequest, signal?: AbortSignal): Promise<DataSlice> {
  const query = new URLSearchParams({
    path: request.path,
    selection: request.selection,
    stride: request.stride,
  });
  if (request.dataset) query.set("dataset", request.dataset);
  const response = await fetch(apiUrl(`data?${query}`), { cache: "no-store", signal });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }

  const dtype = response.headers.get("X-Ncx-Dtype");
  if (dtype !== "f32" && dtype !== "i32" && dtype !== "u32") {
    throw new Error(`Unsupported response dtype ${JSON.stringify(dtype)}`);
  }
  const shapeHeader = response.headers.get("X-Ncx-Shape");
  if (shapeHeader === null) {
    throw new Error("Slice response has no X-Ncx-Shape header");
  }
  const shape = shapeHeader === "" ? [] : shapeHeader.split(",").map(Number);
  if (shape.some((length) => !Number.isSafeInteger(length) || length < 1)) {
    throw new Error(`Invalid response shape ${JSON.stringify(shapeHeader)}`);
  }

  const buffer = await response.arrayBuffer();
  const samples = shape.reduce((total, length) => {
    if (total > Number.MAX_SAFE_INTEGER / length) throw new Error("Slice shape is too large");
    return total * length;
  }, 1);
  if (samples > Number.MAX_SAFE_INTEGER / 4) throw new Error("Slice byte count is too large");
  const expectedBytes = samples * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`Slice body is ${buffer.byteLength} bytes; expected ${expectedBytes}`);
  }
  const values =
    dtype === "f32"
      ? new Float32Array(buffer)
      : dtype === "i32"
        ? new Int32Array(buffer)
        : new Uint32Array(buffer);
  return { dtype, shape, values, request };
}

export function fetchCoordinate(variable: Variable): Promise<Float32Array> {
  return fetchStaticSlice(variable).then((slice) => {
    if (!(slice.values instanceof Float32Array)) {
      throw new Error(`${variable.path} is not a display coordinate`);
    }
    return slice.values;
  });
}

export function fetchStaticSlice(variable: Variable): Promise<DataSlice> {
  const key = `${variable.dataset_id ?? ""}:${variable.path}`;
  let cached = staticSliceCache.get(key);
  if (!cached) {
    cached = fetchSlice({
      dataset: variable.dataset_id,
      path: variable.path,
      selection: variable.dimensions.map(() => ":").join(","),
      stride: variable.dimensions.map(() => "1").join(","),
    });
    staticSliceCache.set(key, cached);
    void cached.catch(() => {
      if (staticSliceCache.get(key) === cached) staticSliceCache.delete(key);
    });
  }
  return cached;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string; suggested_stride?: number[] };
    };
    const message = body.error?.message ?? `${response.status} ${response.statusText}`;
    return body.error?.suggested_stride
      ? `${message} (suggested stride ${body.error.suggested_stride.join(",")})`
      : message;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

interface SliceJob {
  request: SliceRequest;
  accept: (slice: DataSlice) => void;
  reject: (error: Error) => void;
}

/** Keep one server read in flight and retain only the newest desired slice. */
export class LatestSliceLoader {
  private desired: SliceJob | undefined;
  private running = false;
  private disposed = false;
  private active: AbortController | undefined;

  request(job: SliceJob): void {
    this.desired = job;
    if (!this.running) {
      void this.drain();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.desired = undefined;
    this.active?.abort();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (!this.disposed && this.desired) {
      const job = this.desired;
      this.desired = undefined;
      const controller = new AbortController();
      this.active = controller;
      try {
        const slice = await fetchSlice(job.request, controller.signal);
        if (!this.desired && !this.disposed) {
          job.accept(slice);
        }
      } catch (cause) {
        if (!this.desired && !this.disposed) {
          job.reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      } finally {
        if (this.active === controller) this.active = undefined;
      }
    }
    this.running = false;
  }
}
