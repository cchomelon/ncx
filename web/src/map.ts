import type { Bounds } from "./mesh";

export interface Tile {
  key: string;
  url: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function mapTiles(bounds: Bounds, width: number, height: number): Tile[] {
  const longitudeSpan = bounds.maximumX - bounds.minimumX;
  const minimumLatitude = clampLatitude(bounds.minimumY);
  const maximumLatitude = clampLatitude(bounds.maximumY);
  if (
    !Number.isFinite(longitudeSpan) ||
    longitudeSpan <= 0 ||
    longitudeSpan > 360 ||
    maximumLatitude <= minimumLatitude
  ) {
    return [];
  }

  let zoom = Math.max(
    0,
    Math.min(12, Math.floor(Math.log2((Math.max(256, width) * 360) / (256 * longitudeSpan)))),
  );
  let range = tileRange(bounds, zoom);
  while ((range.columns * range.rows > 36 || range.rows * 256 > height * 2.5) && zoom > 0) {
    zoom -= 1;
    range = tileRange(bounds, zoom);
  }

  const tiles: Tile[] = [];
  const longitudeWidth = bounds.maximumX - bounds.minimumX;
  const latitudeHeight = bounds.maximumY - bounds.minimumY;
  const count = 2 ** zoom;
  for (let tileY = range.firstY; tileY <= range.lastY; tileY += 1) {
    if (tileY < 0 || tileY >= count) continue;
    const north = tileLatitude(tileY, zoom);
    const south = tileLatitude(tileY + 1, zoom);
    for (let tileX = range.firstX; tileX <= range.lastX; tileX += 1) {
      const west = (tileX / count) * 360 - 180;
      const east = ((tileX + 1) / count) * 360 - 180;
      const wrappedX = ((tileX % count) + count) % count;
      tiles.push({
        key: `${zoom}/${tileX}/${tileY}`,
        url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
        left: (west - bounds.minimumX) / longitudeWidth,
        top: (bounds.maximumY - north) / latitudeHeight,
        width: (east - west) / longitudeWidth,
        height: (north - south) / latitudeHeight,
      });
    }
  }
  return tiles;
}

function tileRange(bounds: Bounds, zoom: number) {
  const count = 2 ** zoom;
  const firstX = Math.floor(((bounds.minimumX + 180) / 360) * count);
  const lastX = Math.floor(((bounds.maximumX + 180) / 360) * count);
  const firstY = Math.floor(tileY(bounds.maximumY, zoom));
  const lastY = Math.floor(tileY(bounds.minimumY, zoom));
  return {
    firstX,
    lastX,
    firstY,
    lastY,
    columns: lastX - firstX + 1,
    rows: lastY - firstY + 1,
  };
}

function tileY(latitude: number, zoom: number): number {
  const radians = (clampLatitude(latitude) * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * 2 ** zoom;
}

function tileLatitude(y: number, zoom: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom))) * 180) / Math.PI;
}

function clampLatitude(latitude: number): number {
  return Math.max(-85.05112878, Math.min(85.05112878, latitude));
}
