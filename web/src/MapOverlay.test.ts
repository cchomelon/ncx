import assert from "node:assert/strict";
import test from "node:test";

import { mapTiles } from "./map.ts";

test("caps and positions OSM tiles over a longitude/latitude field", () => {
  const tiles = mapTiles(
    { minimumX: 109.4, maximumX: 114.4, minimumY: 20, maximumY: 23.15 },
    1000,
    600,
  );
  assert.ok(tiles.length > 0 && tiles.length <= 36);
  assert.ok(tiles.every((tile) => tile.url.startsWith("https://tile.openstreetmap.org/")));
  assert.ok(tiles.every((tile) => [tile.left, tile.top, tile.width, tile.height].every(Number.isFinite)));
});
