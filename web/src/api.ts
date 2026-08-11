import type { DataSlice, Metadata, SliceRequest, Variable } from "./model";

const staticSliceCache = new Map<string, Promise<DataSlice>>();

export async function fetchMetadata(): Promise<Metadata> {
  const response = await fetch("/api/meta", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return response.json() as Promise<Metadata>;
}

export async function fetchSlice(request: SliceRequest, signal?: AbortSignal): Promise<DataSlice> {
  const query = new URLSearchParams({
    path: request.path,
    selection: request.selection,
    stride: request.stride,
  });
  const response = await fetch(`/api/data?${query}`, { cache: "no-store", signal });
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
  const expectedBytes = shape.reduce((total, length) => total * length, 1) * 4;
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
  let cached = staticSliceCache.get(variable.path);
  if (!cached) {
    cached = fetchSlice({
      path: variable.path,
      selection: variable.dimensions.map(() => ":").join(","),
      stride: variable.dimensions.map(() => "1").join(","),
    });
    staticSliceCache.set(variable.path, cached);
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
