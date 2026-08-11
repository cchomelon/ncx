import { useMemo } from "react";

import type { Bounds } from "./mesh";
import { mapTiles } from "./map";

interface MapOverlayProps {
  bounds: Bounds;
  width: number;
  height: number;
}

/** A small, optional OSM reference layer; the scientific field stays opaque. */
export function MapOverlay({ bounds, width, height }: MapOverlayProps) {
  const tiles = useMemo(() => mapTiles(bounds, width, height), [bounds, width, height]);
  if (tiles.length === 0) return null;
  return (
    <div className="map-overlay" aria-label="OpenStreetMap reference layer">
      {tiles.map((tile) => (
        <img
          key={tile.key}
          src={tile.url}
          alt=""
          style={{
            left: `${tile.left * 100}%`,
            top: `${tile.top * 100}%`,
            width: `${tile.width * 100}%`,
            height: `${tile.height * 100}%`,
          }}
        />
      ))}
      <small>
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
      </small>
    </div>
  );
}
