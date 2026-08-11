export interface ViewBounds {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
}

export interface ViewRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function fitPlotToBounds(plot: ViewRectangle, bounds: ViewBounds): ViewRectangle {
  const dataAspect = (bounds.maximumX - bounds.minimumX) / (bounds.maximumY - bounds.minimumY);
  const plotAspect = plot.width / plot.height;
  if (!Number.isFinite(dataAspect) || dataAspect <= 0) return plot;
  if (dataAspect > plotAspect) {
    const height = plot.width / dataAspect;
    return { ...plot, top: plot.top + (plot.height - height) / 2, height };
  }
  const width = plot.height * dataAspect;
  return { ...plot, left: plot.left + (plot.width - width) / 2, width };
}

export function aspectRectangle(
  first: { x: number; y: number },
  second: { x: number; y: number },
  width: number,
  height: number,
): ViewRectangle {
  const directionX = Math.sign(second.x - first.x) || 1;
  const directionY = Math.sign(second.y - first.y) || 1;
  let boxWidth = Math.abs(second.x - first.x);
  let boxHeight = Math.abs(second.y - first.y);
  const aspect = width / height;
  if (boxWidth / Math.max(boxHeight, Number.EPSILON) > aspect) {
    boxHeight = boxWidth / aspect;
  } else {
    boxWidth = boxHeight * aspect;
  }

  const availableX = directionX > 0 ? width - first.x : first.x;
  const availableY = directionY > 0 ? height - first.y : first.y;
  const scale = Math.min(1, availableX / Math.max(boxWidth, 1), availableY / Math.max(boxHeight, 1));
  const endX = first.x + directionX * boxWidth * scale;
  const endY = first.y + directionY * boxHeight * scale;
  return {
    left: Math.min(first.x, endX),
    top: Math.min(first.y, endY),
    width: Math.abs(endX - first.x),
    height: Math.abs(endY - first.y),
  };
}

export function boxZoomBounds(
  view: ViewBounds,
  box: ViewRectangle,
  width: number,
  height: number,
): ViewBounds {
  const spanX = view.maximumX - view.minimumX;
  const spanY = view.maximumY - view.minimumY;
  return {
    minimumX: view.minimumX + (box.left / width) * spanX,
    maximumX: view.minimumX + ((box.left + box.width) / width) * spanX,
    minimumY: view.maximumY - ((box.top + box.height) / height) * spanY,
    maximumY: view.maximumY - (box.top / height) * spanY,
  };
}

export function zoomBounds(view: ViewBounds, home: ViewBounds, factor: number): ViewBounds {
  const centerX = (view.minimumX + view.maximumX) / 2;
  const centerY = (view.minimumY + view.maximumY) / 2;
  const halfWidth = ((view.maximumX - view.minimumX) * factor) / 2;
  const halfHeight = ((view.maximumY - view.minimumY) * factor) / 2;
  return containBounds({
    minimumX: centerX - halfWidth,
    maximumX: centerX + halfWidth,
    minimumY: centerY - halfHeight,
    maximumY: centerY + halfHeight,
  }, home);
}

export function panBounds(
  view: ViewBounds,
  home: ViewBounds,
  screenDeltaX: number,
  screenDeltaY: number,
): ViewBounds {
  const shiftX = -screenDeltaX * (view.maximumX - view.minimumX);
  const shiftY = screenDeltaY * (view.maximumY - view.minimumY);
  return containBounds({
    minimumX: view.minimumX + shiftX,
    maximumX: view.maximumX + shiftX,
    minimumY: view.minimumY + shiftY,
    maximumY: view.maximumY + shiftY,
  }, home);
}

function containBounds(view: ViewBounds, home: ViewBounds): ViewBounds {
  const homeWidth = home.maximumX - home.minimumX;
  const homeHeight = home.maximumY - home.minimumY;
  if (
    view.maximumX - view.minimumX >= homeWidth ||
    view.maximumY - view.minimumY >= homeHeight
  ) {
    return { ...home };
  }
  const shiftX = view.minimumX < home.minimumX
    ? home.minimumX - view.minimumX
    : view.maximumX > home.maximumX
      ? home.maximumX - view.maximumX
      : 0;
  const shiftY = view.minimumY < home.minimumY
    ? home.minimumY - view.minimumY
    : view.maximumY > home.maximumY
      ? home.maximumY - view.maximumY
      : 0;
  return {
    minimumX: view.minimumX + shiftX,
    maximumX: view.maximumX + shiftX,
    minimumY: view.minimumY + shiftY,
    maximumY: view.maximumY + shiftY,
  };
}
