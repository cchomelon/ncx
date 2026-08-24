import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ncx = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(ncx, "target/debug/ncx");
const browserMode = process.argv[2] ?? "rectilinear";
if (!["rectilinear", "curvilinear", "ugrid", "ugrid_projected", "comparison", "collection", "station"].includes(browserMode)) {
  throw new Error(`unknown browser fixture ${JSON.stringify(browserMode)}`);
}
const fixture = join(ncx, `tests/data/${["comparison", "collection"].includes(browserMode) ? "rectilinear" : browserMode}.nc`);

const injected = `<script>
window.__ncxErrors = [];
window.__ncxStep = "startup";
window.__ncxFetches = [];
window.__ncxScalarReads = 0;
window.__ncxMaxScalarReads = 0;
const reportCrash = (message) => {
  window.__ncxErrors.push(message);
  fetch("/__result?payload=" + encodeURIComponent(JSON.stringify({ failures: [window.__ncxStep + ": " + message], fetches: window.__ncxFetches.length })));
};
addEventListener("error", (event) => reportCrash(String(event.error?.message || event.message) + "\\n" + String(event.error?.stack || "")));
addEventListener("unhandledrejection", (event) => reportCrash(String(event.reason?.message || event.reason) + "\\n" + String(event.reason?.stack || "")));
const originalFetch = window.fetch;
window.fetch = async (...arguments) => {
  const target = String(arguments[0]);
  window.__ncxFetches.push(target);
  const scalar = target.includes("/api/data?") && decodeURIComponent(target).includes("path=/temperature");
  if (scalar) {
    window.__ncxScalarReads += 1;
    window.__ncxMaxScalarReads = Math.max(window.__ncxMaxScalarReads, window.__ncxScalarReads);
  }
  try {
    if (scalar && target.includes("dataset=case-c")) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return await originalFetch(...arguments);
  } finally {
    if (scalar) window.__ncxScalarReads -= 1;
  }
};
</script>
<script type="module">
const browserMode = ${JSON.stringify(browserMode)};
const waitFor = async (test, message, timeout = 4000) => {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const value = test();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(message);
};
// The plotted extent, read from the axes. Comparing tick text instead only
// detected a view change when it happened to move a label, which a small pan
// across round-numbered ticks does not.
const axisExtent = () => {
  const axis = document.querySelector(".plot-axis");
  return (axis?.dataset.xDomain ?? "") + "|" + (axis?.dataset.yDomain ?? "");
};
const hasCorrectAspect = (canvas) => {
  const axis = document.querySelector(".plot-axis");
  const span = (name) => {
    const parts = (axis?.dataset[name] ?? "").split(",").map(Number);
    return parts.length === 2 && parts.every(Number.isFinite) ? Math.abs(parts[1] - parts[0]) : 0;
  };
  const dataAspect = span("xDomain") / span("yDomain");
  if (!Number.isFinite(dataAspect) || dataAspect <= 0) return false;
  const bounds = canvas.getBoundingClientRect();
  return Math.abs(dataAspect / (bounds.width / bounds.height) - 1) < 0.04;
};
const failures = [];
try {
  window.__ncxStep = "initial field";
  const shell = await waitFor(() => document.querySelector(".shell"), "application shell did not mount");
  if (browserMode === "station") {
    const controls = await waitFor(() => {
      const items = [...document.querySelectorAll(".single-curve .series-control")];
      return items.length === 2 ? items : null;
    }, "hosted station did not receive its comparison series");
    const active = document.querySelector(".view-tabs button.active")?.textContent;
    if (active !== "Curve") failures.push("hosted station did not stay in Curve");
    if ([...document.querySelectorAll(".view-tabs button")]
      .some((button) => button.textContent === "Compare")) {
      failures.push("single-station viewer still exposed Compare");
    }
    if (!controls[1].textContent.includes("TPK astronomical reference")) {
      failures.push("hosted station received the wrong comparison series");
    }
    if (!controls[0].textContent.includes("MSL") || !controls[1].textContent.includes("CD")) {
      failures.push("station curve hid the series datums");
    }
    if (document.querySelector(".datum-warning")) failures.push("station curve exposed a datum gate");
    if (controls[1].querySelector('input[type="number"]')) {
      failures.push("CD reference exposed duplicate offsets");
    }
    const cd = controls[1].querySelector('input[type="checkbox"]');
    if (!cd || !cd.parentElement.textContent.includes("CD")) {
      failures.push("CD offset preset is missing");
    }
    const modelY = controls[0].querySelectorAll("input")[1];
    cd?.click();
    await waitFor(() => modelY?.value === "1.45", "CD preset did not set the primary Y offset");
    await waitFor(
      () => document.querySelector(".comparison-line")?.getAttribute("d"),
      "station comparison disappeared after a Y offset",
    );
    const curve = document.querySelector(".curve-svg");
    const bounds = curve.getBoundingClientRect();
    curve.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      clientX: bounds.left + bounds.width * 0.55,
      clientY: bounds.top + bounds.height * 0.5,
    }));
    await waitFor(() => document.querySelector(".hover-crosshair"), "station crosshair did not render");
    if (document.querySelectorAll(".hover-dot").length !== 2) {
      failures.push("station crosshair did not mark both series");
    }
    const tooltip = document.querySelector(".curve-tooltip")?.textContent ?? "";
    if (!tooltip.includes("TPK astronomical reference")) {
      failures.push("station crosshair did not report the reference value");
    }
    if ((tooltip.match(/HKT/g) ?? []).length !== 2) {
      failures.push("station crosshair did not label both sample times");
    }
  } else if (browserMode === "collection") {
    const summaries = await waitFor(() => {
      const items = [...document.querySelectorAll(".collection-file > summary")];
      return items.length === 7 ? items : null;
    }, "directory files were not grouped into summaries");
    const names = summaries.map((summary) => summary.querySelector("strong")?.textContent);
    const expected = [
      "classic.nc",
      "curvilinear.nc",
      "groups.nc",
      "rectilinear.nc",
      "station.nc",
      "ugrid.nc",
      "ugrid_projected.nc",
    ];
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      failures.push("collection files are not sorted: " + names.join(", "));
    }
    if (document.querySelector(".dataset-switcher")) {
      failures.push("directory collection still exposes the dataset dropdown");
    }
    if (window.__ncxFetches.some((url) => url.includes("/api/meta?dataset=file-0006"))) {
      failures.push("closed collection file fetched metadata eagerly");
    }

    summaries[5].click();
    const ugrid = summaries[5].parentElement;
    const nodeTemperature = await waitFor(
      () => [...ugrid.querySelectorAll(".variable-row")]
        .find((button) => button.querySelector("span")?.textContent === "node_temperature"),
      "opening a file summary did not load its variables",
    );
    const metadataFetches = window.__ncxFetches
      .filter((url) => url.includes("/api/meta?dataset=file-0006"));
    if (metadataFetches.length !== 1) {
      failures.push("opening one collection file made " + metadataFetches.length + " metadata requests");
    }
    const visible = [...ugrid.querySelectorAll(".variable-row span")].map((node) => node.textContent);
    for (const supporting of ["mesh", "node_x", "node_y", "face_nodes", "edge_nodes", "edge_faces"]) {
      if (visible.includes(supporting)) failures.push("collection exposed supporting variable " + supporting);
    }
    nodeTemperature.click();
    await waitFor(
      () => document.querySelector(".shell")?.dataset.dataset === "file-0006",
      "collection variable did not switch files",
    );
    await waitFor(
      () => document.querySelector(".mesh-canvas[data-rendered='true']"),
      "collection UGRID variable did not render",
    );
  } else if (browserMode === "comparison") {
    const dataset = await waitFor(
      () => document.querySelector(".dataset-switcher select"),
      "dataset selector did not appear",
    );
    dataset.value = "case-f";
    dataset.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(
      () => document.querySelector(".shell")?.dataset.dataset === "case-f",
      "sixth dataset did not become primary",
    );
    const compare = await waitFor(
      () => [...document.querySelectorAll(".view-tabs button")].find((button) => button.textContent === "Compare"),
      "Compare tab did not appear",
    );
    if (compare.disabled) failures.push("Compare tab is disabled for multiple datasets");
    compare.click();
    const panes = await waitFor(
      () => {
        const items = [...document.querySelectorAll(".field-comparison-pane")];
        return items.length === 4 && items.every((item) => item.querySelector(".field-canvas[data-rendered='true']"))
          ? items
          : null;
      },
      "four field comparison panes did not render",
    );
    if (!panes[0].querySelector("header")?.textContent.includes("case-f")) {
      failures.push("selected sixth dataset was omitted as the comparison primary");
    }
    if (!panes.every((pane) => pane.querySelector("header")?.textContent.includes("Δ 0.0 min"))) {
      failures.push("field panes did not report their actual matched timestamp delta");
    }
    const axes = () => [...document.querySelectorAll(".field-comparison-pane .plot-axis")]
      .map((axis) => axis.dataset.xDomain + "|" + axis.dataset.yDomain);
    const before = axes();
    panes[0].querySelector('button[title="Zoom in"]').click();
    await waitFor(() => {
      const after = axes();
      return after.length === 4 && after[0] !== before[0] && after.every((extent) => extent === after[0]);
    }, "field comparison panes did not synchronize zoom");
    if (!window.__ncxFetches.some((url) => url.includes("dataset=case-a")) ||
        !window.__ncxFetches.some((url) => url.includes("dataset=case-b"))) {
      failures.push("comparison data reads were not qualified by dataset ID");
    }
    window.__ncxMaxScalarReads = 0;
    const timeline = document.querySelector('.timeline input[type="range"]');
    const visitedFrames = new Set([timeline.value]);
    document.querySelector('button[title="Play forward"]').click();
    const playbackDeadline = performance.now() + 1300;
    while (performance.now() < playbackDeadline) {
      visitedFrames.add(timeline.value);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    document.querySelector('button[title="Stop"]').click();
    if (visitedFrames.size < 2) failures.push("field comparison playback did not advance");
    if (window.__ncxMaxScalarReads > 4) {
      failures.push("field comparison advanced before its slowest pane loaded");
    }
    const supporting = [...document.querySelectorAll(".variable-filter label")]
      .find((label) => label.textContent.includes("Show coordinates"))?.querySelector("input");
    supporting.click();
    const latitude = await waitFor(
      () => [...document.querySelectorAll(".variable-row")]
        .find((button) => button.querySelector("span")?.textContent === "lat"),
      "numeric coordinate variable did not appear",
    );
    latitude.click();
    await waitFor(() => document.querySelector(".figure-head h1")?.textContent.includes("latitude"),
      "numeric coordinate curve did not open");
    await waitFor(() => document.querySelector(".curve-line")?.getAttribute("d"),
      "numeric coordinate curve did not render");
    [...document.querySelectorAll(".view-tabs button")]
      .find((button) => button.textContent === "Compare").click();
    const numericComparison = await waitFor(
      () => document.querySelector(".comparison-figure .series-control")
        ? document.querySelector(".comparison-figure")
        : null,
      "numeric curve comparison did not render",
    );
    const numericLabels = [...numericComparison.querySelectorAll(".series-control label")]
      .map((label) => label.textContent.trim());
    const linePatterns = await waitFor(() => {
      const lines = [...numericComparison.querySelectorAll(".comparison-line")];
      return lines.length > 1 ? new Set(lines.map((line) => line.style.strokeDasharray)) : null;
    }, "numeric comparison lines did not render");
    if (linePatterns.size < 2) failures.push("comparison series use colour as their only channel");
    const keyPatterns = new Set([...numericComparison.querySelectorAll(".series-key line")]
      .map((line) => line.style.strokeDasharray));
    if ([...linePatterns].some((pattern) => !keyPatterns.has(pattern))) {
      failures.push("comparison line patterns are missing from the series keys");
    }
    if (numericLabels.some((label) => label.startsWith("X offset"))) {
      failures.push("numeric curve exposed a minute offset: " + numericLabels.join(" | "));
    }
  } else if (browserMode !== "rectilinear") {
    const canvas = await waitFor(() => {
      const node = document.querySelector(".mesh-canvas[data-rendered='true']");
      return node && !document.querySelector(".plot-loading") ? node : null;
    }, "mesh field did not render");
    if (document.querySelector(".plot-error")) failures.push(document.querySelector(".plot-error").textContent);
    const expectedKind = browserMode.startsWith("ugrid") ? "ugrid2d" : browserMode;
    if (!document.querySelector(".figure-head span")?.textContent.includes(expectedKind)) failures.push("mesh view kind is missing");

    if (browserMode.startsWith("ugrid")) {
      const visibleVariables = [...document.querySelectorAll(".variable-row span")].map((row) => row.textContent);
      const supporting = browserMode === "ugrid_projected"
        ? ["Mesh2D", "Mesh2D_node_x", "Mesh2D_node_y", "Mesh2D_node_lon", "Mesh2D_node_lat", "Mesh2D_face_nodes"]
        : ["mesh", "node_x", "node_y", "face_nodes", "edge_nodes", "edge_faces"];
      if (supporting.some((name) => visibleVariables.includes(name))) {
        failures.push("UGRID geometry variables were not filtered by default: " + visibleVariables.join(", "));
      }
    }

    window.__ncxStep = "mesh zoom";
    const beforeZoom = axisExtent();
    const bounds = canvas.getBoundingClientRect();
    const pointer = (type, x, y, options = {}) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      clientX: bounds.left + bounds.width * x,
      clientY: bounds.top + bounds.height * y,
      button: options.button ?? 0,
      buttons: options.buttons ?? 0,
    }));
    pointer("pointermove", 0.5, 0.5);
    const meshHover = await waitFor(() => document.querySelector(".plot-tooltip"), "mesh hover readout did not appear");
    if (!/°[NS].*°[EW]/.test(meshHover.textContent)) failures.push("mesh hover readout did not use latitude then longitude");
    for (const title of ["Zoom in", "Zoom out", "Reset view"]) {
      if (!document.querySelector('button[title="' + title + '"]')) failures.push(title + " control is missing");
    }
    pointer("pointerdown", 0.2, 0.2);
    pointer("pointermove", 0.8, 0.8);
    pointer("pointerup", 0.8, 0.8);
    await waitFor(() => axisExtent() !== beforeZoom, "mesh box zoom did not update axes");
    if (!hasCorrectAspect(canvas)) failures.push("mesh box zoom stretched the coordinate aspect");
    const beforePan = axisExtent();
    pointer("pointerdown", 0.5, 0.5, { button: 1, buttons: 4 });
    pointer("pointermove", 0.6, 0.55, { button: 1, buttons: 4 });
    pointer("pointerup", 0.6, 0.55, { button: 1 });
    await waitFor(() => axisExtent() !== beforePan, "middle-button mesh pan did not update axes");
    document.querySelector('button[title="Reset view"]').click();
    await waitFor(() => axisExtent() === beforeZoom, "mesh Reset view did not restore the full extent");
    document.querySelector('button[title="Zoom in"]').click();
    await waitFor(() => axisExtent() !== beforeZoom, "mesh Zoom in did not update axes");
    document.querySelector('button[title="Zoom out"]').click();
    await waitFor(() => axisExtent() === beforeZoom, "mesh Zoom out did not restore the previous extent");
    pointer("pointerdown", 0.25, 0.25);
    pointer("pointermove", 0.75, 0.75);
    pointer("pointerup", 0.75, 0.75);
    await waitFor(() => axisExtent() !== beforeZoom, "mesh persistence zoom did not update axes");
    const meshViewBeforeTab = axisExtent();

    window.__ncxStep = "mesh probe";
    pointer("pointerdown", 0.5, 0.5);
    pointer("pointerup", 0.5, 0.5);
    await waitFor(() => document.querySelector(".probe-mark"), "mesh probe did not appear");
    if (!/°[NS].*°[EW]/.test(document.querySelector(".statusbar span:last-child")?.textContent ?? "")) failures.push("mesh probe status did not use latitude then longitude");
    if (!/°[NS].*°[EW]/.test(document.querySelector(".figure-head span")?.textContent ?? "")) failures.push("mesh probe subtitle did not use latitude then longitude");
    [...document.querySelectorAll(".view-tabs button")].find((button) => button.textContent === "Curve").click();
    await waitFor(() => document.querySelector(".curve-line")?.getAttribute("d"), "mesh probe curve did not render");
    if (!document.querySelector(".axis-label")?.textContent.includes("Time (HKT)")) failures.push("mesh curve lost CF time");
    const offsetInputs = [...document.querySelectorAll(".curve-offset-controls input")];
    if (offsetInputs.length !== 2) failures.push("single-case time curve offsets are missing");
    if (offsetInputs[0]) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        .set.call(offsetInputs[0], "15");
      offsetInputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(
        () => [...document.querySelectorAll(".axis-label")]
          .some((label) => label.textContent.includes("display offsets")) &&
          offsetInputs[0].value === "15" &&
          !document.querySelector(".curve-offset-controls button")?.disabled,
        "single-case X offset was not applied",
      );
    }
    [...document.querySelectorAll(".view-tabs button")].find((button) => button.textContent === "Field").click();
    await waitFor(() => document.querySelector(".mesh-canvas[data-rendered='true']") && !document.querySelector(".plot-loading"), "mesh Field view did not return");
    if (axisExtent() !== meshViewBeforeTab) failures.push("mesh zoom reset after Curve → Field tab switch");

    if (browserMode === "ugrid") {
      window.__ncxStep = "UGRID face field";
      [...document.querySelectorAll(".variable-row")]
        .find((button) => button.textContent.includes("face_depth"))?.click();
      await waitFor(() => document.querySelector(".mesh-location")?.textContent.includes("face") && document.querySelector(".mesh-canvas[data-rendered='true']"), "UGRID face field did not render");
      window.__ncxStep = "UGRID edge field";
      [...document.querySelectorAll(".variable-row")]
        .find((button) => button.textContent.includes("edge_current"))?.click();
      await waitFor(() => document.querySelector(".mesh-location")?.textContent.includes("edge") && document.querySelector(".mesh-canvas[data-rendered='true']"), "UGRID edge field did not render");
      const edgeCanvas = document.querySelector(".mesh-canvas");
      const edgeBounds = edgeCanvas.getBoundingClientRect();
      for (const type of ["pointerdown", "pointerup"]) {
        edgeCanvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          clientX: edgeBounds.left + edgeBounds.width * 0.75,
          clientY: edgeBounds.top + edgeBounds.height * 0.5,
          button: 0,
        }));
      }
      await waitFor(() => document.querySelector(".probe-mark"), "UGRID edge probe did not appear");
      [...document.querySelectorAll(".view-tabs button")].find((button) => button.textContent === "Curve").click();
      await waitFor(
        () => document.querySelector(".curve-axis")?.dataset.yDomain === "4.25,6.25",
        "UGRID edge probe curve did not average the face's adjacent edges",
      );
    }
    if (shell !== document.querySelector(".shell")) failures.push("mesh interactions replaced the application shell");
  } else {
  const canvas = await waitFor(() => {
    const node = document.querySelector(".field-canvas[data-rendered='true']");
    return node && !document.querySelector(".plot-loading") ? node : null;
  }, "field slice did not render");
  if (!document.querySelector(".path")?.textContent.includes("rectilinear.nc")) failures.push("dataset identity is missing");
  if (!document.querySelector(".statusbar")?.textContent.includes("dim(")) failures.push("status shape does not identify display dimensions");
  await waitFor(() => document.querySelector(".figure-head h1")?.textContent === "2024-07-25 18:00 HKT", "field title did not use valid CF time");
  if (!document.querySelector(".figure-head span")?.textContent.includes("Potential temperature")) failures.push("field subtitle lost the variable label");
  if (![...document.querySelectorAll(".timeline-fishbone b")].some((label) => label.textContent === "18")) failures.push("timeline fishbone did not show two-digit hours");
  if (document.querySelector(".timeline-axis-title")?.textContent !== "Time (HKT)") failures.push("timeline axis title did not show timezone");

  const context = canvas.getContext("2d");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const colors = new Set();
  for (let index = 0; index < pixels.length; index += 4) {
    colors.add([pixels[index], pixels[index + 1], pixels[index + 2]].join(","));
  }
  if (colors.size < 8) failures.push("field canvas does not contain real scalar colours");

  const stableReads = window.__ncxFetches.length;
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (window.__ncxFetches.length !== stableReads) failures.push("stable view kept refetching");

  window.__ncxStep = "range controls";
  const rangeSelect = [...document.querySelectorAll(".display-controls label")]
    .find((label) => label.textContent.trim().startsWith("Range"))?.querySelector("select");
  rangeSelect.value = "locked";
  rangeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  const minimum = await waitFor(() => document.querySelector('input[aria-label="Colour range minimum"]'), "locked range controls did not appear");
  const noStyleFetch = window.__ncxFetches.length;
  minimum.value = "300";
  minimum.dispatchEvent(new Event("input", { bubbles: true }));
  const maximum = document.querySelector('input[aria-label="Colour range maximum"]');
  maximum.value = "304";
  maximum.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (window.__ncxFetches.length !== noStyleFetch) failures.push("range-only edit fetched scalar data");

  window.__ncxStep = "field zoom";
  const bounds = canvas.getBoundingClientRect();
  const fieldPointer = (type, x, y, options = {}) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    clientX: bounds.left + bounds.width * x,
    clientY: bounds.top + bounds.height * y,
    button: options.button ?? 0,
    buttons: options.buttons ?? 0,
  }));
  fieldPointer("pointermove", 0.63, 0.44);
  const fieldHover = await waitFor(() => document.querySelector(".plot-tooltip"), "field hover readout did not appear");
  if (!/°[NS].*°[EW]/.test(fieldHover.textContent)) failures.push("field hover readout did not use latitude then longitude");
  for (const title of ["Zoom in", "Zoom out", "Reset view"]) {
    if (!document.querySelector('button[title="' + title + '"]')) failures.push(title + " control is missing");
  }
  const axisBeforeZoom = axisExtent();
  fieldPointer("pointerdown", 0.2, 0.2);
  fieldPointer("pointermove", 0.8, 0.8);
  fieldPointer("pointerup", 0.8, 0.8);
  await waitFor(() => axisExtent() !== axisBeforeZoom, "field box zoom did not update axes");
  if (!hasCorrectAspect(canvas)) failures.push("field box zoom stretched the coordinate aspect");
  const fieldBeforePan = axisExtent();
  fieldPointer("pointerdown", 0.5, 0.5, { button: 1, buttons: 4 });
  fieldPointer("pointermove", 0.6, 0.55, { button: 1, buttons: 4 });
  fieldPointer("pointerup", 0.6, 0.55, { button: 1 });
  await waitFor(() => axisExtent() !== fieldBeforePan, "middle-button field pan did not update axes");
  document.querySelector('button[title="Reset view"]').click();
  await waitFor(() => axisExtent() === axisBeforeZoom, "field Reset view did not restore the full extent");
  document.querySelector('button[title="Zoom in"]').click();
  await waitFor(() => axisExtent() !== axisBeforeZoom, "field Zoom in did not update axes");
  document.querySelector('button[title="Zoom out"]').click();
  await waitFor(() => axisExtent() === axisBeforeZoom, "field Zoom out did not restore the previous extent");
  fieldPointer("pointerdown", 0.25, 0.25);
  fieldPointer("pointermove", 0.75, 0.75);
  fieldPointer("pointerup", 0.75, 0.75);
  await waitFor(() => axisExtent() !== axisBeforeZoom, "field persistence zoom did not update axes");
  const fieldViewBeforeTab = axisExtent();
  if (!document.querySelector('button[title="Save plot as PNG"]')) failures.push("plot PNG control is missing");

  window.__ncxStep = "probe";
  fieldPointer("pointerdown", 0.63, 0.44);
  fieldPointer("pointerup", 0.63, 0.44);
  await waitFor(() => document.querySelector(".probe-mark"), "field probe did not appear");
  if (!/°[NS].*°[EW]/.test(document.querySelector(".statusbar span:last-child")?.textContent ?? "")) failures.push("field probe status did not use latitude then longitude");

  window.__ncxStep = "curve";
  [...document.querySelectorAll(".view-tabs button")].find((button) => button.textContent === "Curve").click();
  const curve = await waitFor(() => {
    const line = document.querySelector(".curve-line");
    return line?.getAttribute("d") ? document.querySelector(".curve-svg") : null;
  }, "probe curve did not render");
  if (!document.querySelector(".axis-label")?.textContent.includes("Time (HKT)")) failures.push("valid CF time did not produce an HKT axis");

  const curveBounds = curve.getBoundingClientRect();
  curve.dispatchEvent(new PointerEvent("pointermove", {
    bubbles: true,
    clientX: curveBounds.left + curveBounds.width * 0.637,
    clientY: curveBounds.top + curveBounds.height * 0.45,
  }));
  const crosshair = await waitFor(() => document.querySelector(".hover-crosshair"), "curve crosshair did not appear");
  const marker = document.querySelector(".hover-dot");
  if (document.querySelectorAll(".hover-crosshair").length !== 1) failures.push("curve has duplicate crosshairs");
  if (Math.abs(Number(crosshair.getAttribute("x1")) - Number(marker?.getAttribute("cx"))) < 0.2) failures.push("crosshair did not move continuously between samples");
  if (!document.querySelector(".curve-tooltip")) failures.push("curve tooltip did not appear");

  window.__ncxStep = "field return";
  [...document.querySelectorAll(".view-tabs button")].find((button) => button.textContent === "Field").click();
  await waitFor(() => document.querySelector(".field-canvas[data-rendered='true']") && !document.querySelector(".plot-loading"), "Field view did not return");
  if (axisExtent() !== fieldViewBeforeTab) failures.push("field zoom reset after Curve → Field tab switch");
  if (shell !== document.querySelector(".shell")) failures.push("view switch replaced the application shell");
  if (document.querySelectorAll(".field-canvas").length !== 1) failures.push("view switch duplicated the field canvas");

  window.__ncxStep = "playback";
  window.__ncxMaxScalarReads = window.__ncxScalarReads;
  document.querySelector('button[title="Play forward"]').click();
  await waitFor(() => document.querySelector(".timeline output")?.textContent.includes("00:00"), "frame-paced playback did not advance");
  document.querySelector('button[title="Stop"]').click();
  if (window.__ncxMaxScalarReads > 1) failures.push("animation overlapped scalar reads");

  window.__ncxStep = "scalar";
  [...document.querySelectorAll(".variable-row")]
    .find((button) => button.textContent.includes("reference_pressure"))?.click();
  await waitFor(() => Math.abs(Number(document.querySelector(".scalar-value strong")?.textContent) - 101325) < 100, "rank-zero scalar did not render");
  }
} catch (error) {
  failures.push(
    window.__ncxStep + ": " + String(error.message || error) +
    " · plot: " + (document.querySelector(".plot-error")?.textContent || "none") +
    " · mesh: " + (document.querySelector(".mesh-canvas")?.outerHTML || "none") +
    " · status: " + (document.querySelector(".statusbar")?.textContent || "none") +
    "\\n" + String(error.stack || ""),
  );
}
failures.push(...window.__ncxErrors);
await fetch("/__result?payload=" + encodeURIComponent(JSON.stringify({ failures, fetches: window.__ncxFetches.length })));
</script>`;

const childArguments = browserMode === "comparison"
  ? [
      "serve",
      "--port",
      "0",
      ...["a", "b", "c", "d", "e", "f"].flatMap((id) => ["--dataset", `case-${id}=${fixture}`]),
    ]
  : browserMode === "collection"
    ? ["serve", "--port", "0", join(ncx, "tests/data")]
  : ["serve", "--port", "0", fixture];
const child = spawn(binary, childArguments, {
  cwd: ncx,
  stdio: ["ignore", "pipe", "pipe"],
});
let startup = "";
const upstreamPort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`ncx startup timed out: ${startup}`)), 10000);
  const inspect = (chunk) => {
    startup += chunk;
    const match = /NCX_READY=127\.0\.0\.1:(\d+)/.exec(startup);
    if (match) {
      clearTimeout(timer);
      resolve(Number(match[1]));
    }
  };
  child.stdout.on("data", (chunk) => inspect(chunk.toString()));
  child.stderr.on("data", (chunk) => inspect(chunk.toString()));
  child.once("exit", (code) => reject(new Error(`ncx exited during startup (${code}): ${startup}`)));
});

let finish;
const result = new Promise((resolve) => { finish = resolve; });
let proxyHits = 0;
const stationOrigin = Date.parse("2025-09-20T09:00:00Z");
const stationSamples = 23_039;
const stationSeries = [{
  id: "reference:TPK",
  label: "TPK astronomical reference",
  quantity: "sea_surface_height_above_mean_sea_level",
  location_id: "TPK",
  x_units: "milliseconds since 1970-01-01T00:00:00Z",
  x: Array.from({ length: stationSamples }, (_, index) => stationOrigin + index * 60_000),
  y_units: "m",
  vertical_datum: "CD",
  primary_y_offset: 1.45,
  y: Array.from({ length: stationSamples }, (_, index) => Math.sin(index / 1440)),
}];
const stationHost = `<!doctype html><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style>
<iframe src="/ncx/?display_zone=HKT%2C480&comparison_host=1&generation=1"></iframe>
<script>addEventListener("message",(event)=>{const request=event.data;if(request?.type!=="ncx:comparison-request"||request.quantity!=="sea_surface_height_above_mean_sea_level"||request.units!=="m")return;
event.source.postMessage({type:"ncx:comparison-ready",request_id:request.request_id,generation:request.generation,series:${JSON.stringify(stationSeries)}},location.origin)});</script>`;
const proxy = createServer(async (request, response) => {
  proxyHits += 1;
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/__result") {
    response.end("ok");
    finish(JSON.parse(url.searchParams.get("payload")));
    return;
  }
  if (browserMode === "station" && url.pathname === "/host") {
    response.setHeader("Content-Type", "text/html");
    response.end(stationHost);
    return;
  }
  try {
    const upstreamPath = browserMode === "station" && url.pathname.startsWith("/ncx/")
      ? request.url.slice(4)
      : request.url;
    const upstream = await fetch(`http://127.0.0.1:${upstreamPort}${upstreamPath}`);
    let body = Buffer.from(await upstream.arrayBuffer());
    if (new URL(upstreamPath, "http://127.0.0.1").pathname === "/") {
      body = Buffer.from(body.toString().replace('<script type="module"', `${injected}<script type="module"`));
    }
    response.statusCode = upstream.status;
    for (const [name, value] of upstream.headers) {
      if (name !== "content-length" && name !== "content-encoding") response.setHeader(name, value);
    }
    response.end(body);
  } catch (error) {
    response.statusCode = 502;
    response.end(String(error));
  }
});

await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = proxy.address().port;
const profile = await mkdtemp(join(tmpdir(), "ncx-ui-smoke-"));
await writeFile(join(profile, "user.js"), `
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("network.captive-portal-service.enabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("toolkit.telemetry.unified", false);
`);
const browser = spawn(
  "firefox",
  [
    "--headless",
    "-no-remote",
    "-profile",
    profile,
    browserMode === "station"
      ? `http://127.0.0.1:${proxyPort}/host`
      : `http://127.0.0.1:${proxyPort}/?display_zone=HKT%2C480&comparison_host=1&generation=1`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let browserError = "";
browser.stderr.on("data", (chunk) => { browserError += chunk; });
const payload = await Promise.race([
  result,
  new Promise((resolve) => setTimeout(() => resolve({ failures: [`browser check timed out after ${proxyHits} HTTP requests: ${browserError.trim()}`], fetches: 0 }), 20000)),
]);

browser.kill("SIGTERM");
child.kill("SIGINT");
proxy.close();
await rm(profile, { recursive: true, force: true });
console.log(JSON.stringify(payload, null, 2));
process.exitCode = payload.failures.length ? 1 : 0;
