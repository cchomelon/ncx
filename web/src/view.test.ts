import assert from "node:assert/strict";
import test from "node:test";

import {
  aspectRectangle,
  boxZoomBounds,
  fitPlotToBounds,
  panBounds,
  projectRectangle,
  zoomBounds,
} from "./view.ts";

const home = { minimumX: 0, maximumX: 4, minimumY: 0, maximumY: 2 };
const plot = { left: 0, top: 0, width: 800, height: 600 };

test("fits the plot without stretching data coordinates", () => {
  assert.deepEqual(fitPlotToBounds(plot, home), {
    left: 0,
    top: 100,
    width: 800,
    height: 400,
  });
});

test("projects a panned raster without stretching it", () => {
  const raster = { left: 0.25, top: 0.25, width: 0.5, height: 0.5 };
  assert.deepEqual(
    projectRectangle(
      raster,
      { minimumX: 0.375, maximumX: 0.875, minimumY: 0.25, maximumY: 0.75 },
      800,
      600,
    ),
    { left: -200, top: 0, width: 800, height: 600 },
  );
});

test("box zoom, buttons, and panning preserve the home aspect", () => {
  const box = aspectRectangle({ x: 100, y: 100 }, { x: 500, y: 250 }, 800, 400);
  assert.equal(box.width / box.height, 2);

  const selected = boxZoomBounds(home, box, 800, 400);
  assert.equal((selected.maximumX - selected.minimumX) / (selected.maximumY - selected.minimumY), 2);

  const closer = zoomBounds(home, home, 0.5);
  assert.deepEqual(closer, { minimumX: 1, maximumX: 3, minimumY: 0.5, maximumY: 1.5 });
  assert.deepEqual(zoomBounds(closer, home, 2), home);
  assert.notDeepEqual(panBounds(closer, home, 0.1, -0.1), closer);
});
