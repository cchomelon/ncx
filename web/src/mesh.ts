export interface Bounds {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
}

/** Expanded triangles plus the source scalar used by every rendered vertex. */
export interface MeshGeometry {
  positions: Float32Array;
  scalarIndices: Uint32Array;
  coordinateIndices: Uint32Array;
  triangleSources: Uint32Array;
  bounds: Bounds;
  hitIndex: MeshHitIndex;
  longitude?: Float32Array;
  latitude?: Float32Array;
}

interface MeshHitIndex {
  columns: number;
  rows: number;
  cells: number[][];
}

export interface MeshHit {
  scalarIndex: number;
  coordinateIndex: number;
  triangleSource: number;
  x: number;
  y: number;
  longitude?: number;
  latitude?: number;
}

export function buildCurvilinearGeometry(
  x: Float32Array,
  y: Float32Array,
  sourceRows: number,
  sourceColumns: number,
  sampledRows: number,
  sampledColumns: number,
  rowStride: number,
  columnStride: number,
): MeshGeometry {
  if (x.length !== sourceRows * sourceColumns || y.length !== x.length) {
    throw new Error("curvilinear coordinate shapes do not match");
  }

  const positions: number[] = [];
  const scalarIndices: number[] = [];
  const coordinateIndices: number[] = [];
  const triangleSources: number[] = [];
  const coordinateIndex = (row: number, column: number) => {
    const sourceRow = Math.min(sourceRows - 1, row * rowStride);
    const sourceColumn = Math.min(sourceColumns - 1, column * columnStride);
    return sourceRow * sourceColumns + sourceColumn;
  };
  const addVertex = (row: number, column: number) => {
    const coordinate = coordinateIndex(row, column);
    positions.push(x[coordinate], y[coordinate]);
    scalarIndices.push(row * sampledColumns + column);
    coordinateIndices.push(coordinate);
  };

  for (let row = 0; row + 1 < sampledRows; row += 1) {
    for (let column = 0; column + 1 < sampledColumns; column += 1) {
      const corners = [
        coordinateIndex(row, column),
        coordinateIndex(row, column + 1),
        coordinateIndex(row + 1, column + 1),
        coordinateIndex(row + 1, column),
      ];
      if (corners.some((index) => !Number.isFinite(x[index]) || !Number.isFinite(y[index]))) {
        continue;
      }
      addVertex(row, column);
      addVertex(row, column + 1);
      addVertex(row + 1, column + 1);
      addVertex(row, column);
      addVertex(row + 1, column + 1);
      addVertex(row + 1, column);
      const cell = row * Math.max(1, sampledColumns - 1) + column;
      triangleSources.push(cell, cell);
    }
  }

  return finishGeometry(positions, scalarIndices, coordinateIndices, triangleSources);
}

export function buildUgridGeometry(
  x: Float32Array,
  y: Float32Array,
  connectivity: Int32Array | Uint32Array,
  faceCount: number,
  nodesPerFace: number,
  startIndex: number,
  paddingValues: readonly number[],
  location: "node" | "face",
): MeshGeometry {
  if (x.length !== y.length) throw new Error("UGRID node coordinate lengths do not match");
  if (connectivity.length !== faceCount * nodesPerFace) {
    throw new Error("UGRID connectivity shape does not match its values");
  }

  const padding = new Set(paddingValues);
  const positions: number[] = [];
  const scalarIndices: number[] = [];
  const coordinateIndices: number[] = [];
  const triangleSources: number[] = [];

  for (let face = 0; face < faceCount; face += 1) {
    const nodes: number[] = [];
    for (let offset = 0; offset < nodesPerFace; offset += 1) {
      const packed = Number(connectivity[face * nodesPerFace + offset]);
      if (padding.has(packed)) continue;
      const node = packed - startIndex;
      if (!Number.isSafeInteger(node) || node < 0 || node >= x.length) {
        throw new Error(`UGRID face ${face} refers to invalid node ${packed}`);
      }
      if (nodes.at(-1) !== node) nodes.push(node);
    }
    if (nodes.length > 3 && nodes[0] === nodes.at(-1)) nodes.pop();
    if (nodes.length < 3) throw new Error(`UGRID face ${face} has fewer than three nodes`);
    if (nodes.some((node) => !Number.isFinite(x[node]) || !Number.isFinite(y[node]))) {
      throw new Error(`UGRID face ${face} has a missing node coordinate`);
    }

    for (const [a, b, c] of triangulate(nodes, x, y)) {
      for (const node of [a, b, c]) {
        positions.push(x[node], y[node]);
        scalarIndices.push(location === "node" ? node : face);
        coordinateIndices.push(node);
      }
      triangleSources.push(face);
    }
  }

  return finishGeometry(positions, scalarIndices, coordinateIndices, triangleSources);
}

export function edgesToFaces(
  edgeValues: Float32Array,
  edgeFaces: Int32Array,
  faceCount: number,
): Float32Array {
  if (edgeFaces.length !== edgeValues.length * 2) {
    throw new Error("UGRID edge-face connectivity must contain two faces per edge");
  }
  const sums = new Float32Array(faceCount);
  const counts = new Uint32Array(faceCount);
  edgeFaces.forEach((entry, index) => {
    const face = Number(entry);
    const value = edgeValues[index >> 1];
    if (!Number.isFinite(value) || !Number.isInteger(face) || face < 0 || face >= faceCount) return;
    sums[face] += value;
    counts[face] += 1;
  });
  return Float32Array.from(sums, (sum, face) => counts[face] ? sum / counts[face] : Number.NaN);
}

export function findMeshHit(
  geometry: MeshGeometry,
  dataX: number,
  dataY: number,
): MeshHit | undefined {
  const { positions, scalarIndices, coordinateIndices, triangleSources } = geometry;
  const cell = hitCell(geometry, dataX, dataY);
  if (!cell) return undefined;
  for (const triangle of cell) {
    const vertex = triangle * 3;
    const ax = positions[vertex * 2];
    const ay = positions[vertex * 2 + 1];
    const bx = positions[(vertex + 1) * 2];
    const by = positions[(vertex + 1) * 2 + 1];
    const cx = positions[(vertex + 2) * 2];
    const cy = positions[(vertex + 2) * 2 + 1];
    if (!pointInTriangle(dataX, dataY, ax, ay, bx, by, cx, cy)) continue;
    const nearest = [
      squaredDistance(dataX, dataY, ax, ay),
      squaredDistance(dataX, dataY, bx, by),
      squaredDistance(dataX, dataY, cx, cy),
    ].indexOf(Math.min(
      squaredDistance(dataX, dataY, ax, ay),
      squaredDistance(dataX, dataY, bx, by),
      squaredDistance(dataX, dataY, cx, cy),
    ));
    const selected = vertex + nearest;
    const coordinateIndex = coordinateIndices[selected];
    return {
      scalarIndex: scalarIndices[selected],
      coordinateIndex,
      triangleSource: triangleSources[vertex / 3],
      x: positions[selected * 2],
      y: positions[selected * 2 + 1],
      longitude: geometry.longitude?.[coordinateIndex],
      latitude: geometry.latitude?.[coordinateIndex],
    };
  }
  return undefined;
}

function triangulate(
  nodes: readonly number[],
  x: Float32Array,
  y: Float32Array,
): Array<[number, number, number]> {
  if (nodes.length === 3) return [[nodes[0], nodes[1], nodes[2]]];
  const remaining = nodes.map((_, index) => index);
  const triangles: Array<[number, number, number]> = [];
  const orientation = polygonArea(nodes, x, y) >= 0 ? 1 : -1;

  while (remaining.length > 3) {
    let clipped = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const previous = remaining[(index + remaining.length - 1) % remaining.length];
      const current = remaining[index];
      const next = remaining[(index + 1) % remaining.length];
      const a = nodes[previous];
      const b = nodes[current];
      const c = nodes[next];
      if (orientation * cross(x[a], y[a], x[b], y[b], x[c], y[c]) <= 0) continue;
      const containsNode = remaining.some((candidate) =>
        candidate !== previous &&
        candidate !== current &&
        candidate !== next &&
        pointInTriangle(x[nodes[candidate]], y[nodes[candidate]], x[a], y[a], x[b], y[b], x[c], y[c]),
      );
      if (containsNode) continue;
      triangles.push(orientation > 0 ? [a, b, c] : [c, b, a]);
      remaining.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error("UGRID polygon is self-intersecting or degenerate");
  }

  const [a, b, c] = remaining.map((index) => nodes[index]);
  triangles.push(orientation > 0 ? [a, b, c] : [c, b, a]);
  return triangles;
}

function polygonArea(nodes: readonly number[], x: Float32Array, y: Float32Array): number {
  let area = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const first = nodes[index];
    const second = nodes[(index + 1) % nodes.length];
    area += x[first] * y[second] - x[second] * y[first];
  }
  return area / 2;
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const first = cross(ax, ay, bx, by, px, py);
  const second = cross(bx, by, cx, cy, px, py);
  const third = cross(cx, cy, ax, ay, px, py);
  return (first >= 0 && second >= 0 && third >= 0) || (first <= 0 && second <= 0 && third <= 0);
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function squaredDistance(ax: number, ay: number, bx: number, by: number): number {
  return (ax - bx) ** 2 + (ay - by) ** 2;
}

function finishGeometry(
  positions: number[],
  scalarIndices: number[],
  coordinateIndices: number[],
  triangleSources: number[],
): MeshGeometry {
  if (positions.length === 0) throw new Error("mesh has no renderable triangles");
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 2) {
    minimumX = Math.min(minimumX, positions[index]);
    maximumX = Math.max(maximumX, positions[index]);
    minimumY = Math.min(minimumY, positions[index + 1]);
    maximumY = Math.max(maximumY, positions[index + 1]);
  }
  if (minimumX === maximumX) maximumX = minimumX + 1;
  if (minimumY === maximumY) maximumY = minimumY + 1;
  const geometry = {
    positions: Float32Array.from(positions),
    scalarIndices: Uint32Array.from(scalarIndices),
    coordinateIndices: Uint32Array.from(coordinateIndices),
    triangleSources: Uint32Array.from(triangleSources),
    bounds: { minimumX, maximumX, minimumY, maximumY },
  };
  return { ...geometry, hitIndex: buildHitIndex(geometry) };
}

function buildHitIndex(geometry: Omit<MeshGeometry, "hitIndex">): MeshHitIndex {
  const triangleCount = geometry.triangleSources.length;
  // ponytail: 128² bounds index keeps hover cheap without a general mesh tree;
  // replace it only if measured pathological meshes span many grid cells.
  const divisions = Math.max(1, Math.min(128, Math.ceil(Math.sqrt(triangleCount / 16))));
  const cells = Array.from({ length: divisions * divisions }, () => [] as number[]);
  const column = (x: number) => gridIndex(
    x,
    geometry.bounds.minimumX,
    geometry.bounds.maximumX,
    divisions,
  );
  const row = (y: number) => gridIndex(
    y,
    geometry.bounds.minimumY,
    geometry.bounds.maximumY,
    divisions,
  );
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const vertex = triangle * 3;
    const xs = [
      geometry.positions[vertex * 2],
      geometry.positions[(vertex + 1) * 2],
      geometry.positions[(vertex + 2) * 2],
    ];
    const ys = [
      geometry.positions[vertex * 2 + 1],
      geometry.positions[(vertex + 1) * 2 + 1],
      geometry.positions[(vertex + 2) * 2 + 1],
    ];
    const firstColumn = column(Math.min(...xs));
    const lastColumn = column(Math.max(...xs));
    const firstRow = row(Math.min(...ys));
    const lastRow = row(Math.max(...ys));
    for (let gridRow = firstRow; gridRow <= lastRow; gridRow += 1) {
      for (let gridColumn = firstColumn; gridColumn <= lastColumn; gridColumn += 1) {
        cells[gridRow * divisions + gridColumn].push(triangle);
      }
    }
  }
  return { columns: divisions, rows: divisions, cells };
}

function hitCell(geometry: MeshGeometry, x: number, y: number): number[] | undefined {
  if (
    x < geometry.bounds.minimumX || x > geometry.bounds.maximumX ||
    y < geometry.bounds.minimumY || y > geometry.bounds.maximumY
  ) {
    return undefined;
  }
  const column = gridIndex(
    x,
    geometry.bounds.minimumX,
    geometry.bounds.maximumX,
    geometry.hitIndex.columns,
  );
  const row = gridIndex(
    y,
    geometry.bounds.minimumY,
    geometry.bounds.maximumY,
    geometry.hitIndex.rows,
  );
  return geometry.hitIndex.cells[row * geometry.hitIndex.columns + column];
}

function gridIndex(value: number, minimum: number, maximum: number, count: number): number {
  const fraction = (value - minimum) / (maximum - minimum);
  return Math.max(0, Math.min(count - 1, Math.floor(fraction * count)));
}
