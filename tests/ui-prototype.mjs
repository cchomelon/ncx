import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ncx = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(ncx);
const pagePath = join(ncx, "ui-prototype.html");
const injected = `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const app = document.querySelector("#app");
  app.style.cssText = "width:500px;height:500px";
  await frame();
  await frame();
  await frame();
  await frame();
  const failures = [];
  const shell = document.querySelector(".shell");
  const refreshes = { viewer: 0, field: 0, curve: 0 };
  const originalRenderViewer = renderViewer;
  const originalLayoutField = layoutField;
  const originalLayoutCurve = layoutCurve;
  renderViewer = (...args) => { refreshes.viewer += 1; return originalRenderViewer(...args); };
  layoutField = (...args) => { refreshes.field += 1; return originalLayoutField(...args); };
  layoutCurve = (...args) => { refreshes.curve += 1; return originalLayoutCurve(...args); };
  document.querySelector('[data-view="curve"]').click();
  await frame();
  await frame();
  await frame();
  const curveRefreshes = { ...refreshes };
  refreshes.viewer = 0;
  refreshes.field = 0;
  refreshes.curve = 0;
  document.querySelector('[data-view="field"]').click();
  await frame();
  await frame();
  await frame();
  const fieldRefreshes = { ...refreshes };
  const singlePassViews = curveRefreshes.viewer === 1 && curveRefreshes.curve === 1 && fieldRefreshes.viewer === 1 && fieldRefreshes.field === 1;
  const canvas = document.querySelector("[data-field-canvas]");
  const bounds = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }));
  const centreValue = curveValue(80).total;
  canvas.dispatchEvent(new PointerEvent("click", { clientX: bounds.left + bounds.width * 0.2, clientY: bounds.top + bounds.height * 0.8 }));
  const fieldClickSelects = Math.abs(state.probe.fx - 0.2) < 0.02 && Math.abs(state.probe.fy - 0.8) < 0.02;
  const curveUsesProbe = Math.abs(curveValue(80).total - centreValue) > 0.01;
  const fieldSingleCursor = getComputedStyle(canvas).cursor === "none" && document.querySelectorAll("[data-probe-mark] line").length === 2;
  setProbe((110.11 - FIELD_BOUNDS.west) / (FIELD_BOUNDS.east - FIELD_BOUNDS.west), latToFrac(23.96));

  document.querySelector('[data-view="curve"]').click();
  await frame();
  await frame();
  const figureHead = document.querySelector(".figure-head");
  const figureTitle = document.querySelector(".figure-title");
  const figureSubtitle = document.querySelector(".figure-subtitle");
  const probeHeader = figureSubtitle.textContent === "at 110.11°E, 23.96°N";
  const headerMetrics = { title: [figureTitle.clientWidth, figureTitle.scrollWidth], subtitleRight: figureSubtitle.getBoundingClientRect().right, headRight: figureHead.getBoundingClientRect().right };
  const headerFits = headerMetrics.title[1] <= headerMetrics.title[0] && headerMetrics.subtitleRight <= headerMetrics.headRight + 0.5;
  const curve = document.querySelector('[data-plot-frame][data-kind="curve"]');
  const curveBounds = curve.getBoundingClientRect();
  curve.dispatchEvent(new PointerEvent("pointermove", { clientX: curveBounds.left + curveBounds.width * 0.637, clientY: curveBounds.top + curveBounds.height * 0.45 }));
  const tracker = document.querySelector("[data-crosshair]");
  const lineX = Number(tracker.querySelector(".hover-crosshair").getAttribute("x1"));
  const markerX = Number(tracker.querySelector(".hover-dot").getAttribute("cx"));
  const hoverContinuous = Math.abs(lineX - markerX) > 0.15;
  const oneCurveCrosshair = getComputedStyle(document.querySelector("[data-time-layer]")).visibility === "hidden";
  const smallTitleSize = parseFloat(getComputedStyle(figureTitle).fontSize);
  const smallTooltipSize = parseFloat(getComputedStyle(tracker.querySelector(".tooltip-text")).fontSize);

  stopPlayback();
  const cursorPositions = [];
  let markersSnapped = true;
  startPlayback(1);
  for (let i = 0; i < 14; i += 1) {
    await frame();
    const svg = document.querySelector("[data-plot-svg]");
    cursorPositions.push(svg.querySelector("[data-time-cursor]").getAttribute("x1"));
    markersSnapped &&= Math.abs(Number(svg.querySelector('[data-time-sample="total"]').getAttribute("cx")) - svg._geometry.xScale(state.time)) < 0.11;
  }
  stopPlayback();

  const smallAxisSize = parseFloat(getComputedStyle(document.querySelector(".axislabel")).fontSize);
  app.style.cssText = "width:1600px;height:900px";
  await frame();
  await frame();
  const largeAxisSize = parseFloat(getComputedStyle(document.querySelector(".axislabel")).fontSize);
  const largeTitleSize = parseFloat(getComputedStyle(figureTitle).fontSize);
  const largeTooltipSize = parseFloat(getComputedStyle(document.querySelector(".tooltip-text")).fontSize);
  app.style.cssText = "width:500px;height:500px";
  await frame();

  document.querySelector('[data-view="field"]').click();
  await frame();
  const shellStable = shell === document.querySelector(".shell");
  const viewRoundTrip = Boolean(document.querySelector("[data-field-canvas]"));
  if (!shellStable) failures.push("view changes replaced the app shell");
  if (!singlePassViews) failures.push("one view action redrew repeatedly: curve=" + JSON.stringify(curveRefreshes) + " field=" + JSON.stringify(fieldRefreshes));
  if (!viewRoundTrip) failures.push("Curve→Field did not restore the field plot");
  if (!fieldClickSelects || !curveUsesProbe) failures.push("field selection did not drive the curve");
  if (!probeHeader || !headerFits) failures.push("probe title did not respond within the narrow plot header");
  if (!fieldSingleCursor || !oneCurveCrosshair) failures.push("a plot showed duplicate crosshairs");
  if (!hoverContinuous || !markersSnapped) failures.push("tracker and sample markers were not independently positioned");
  if (new Set(cursorPositions).size < 9) failures.push("playback cursor was not continuous");
  if (largeAxisSize <= smallAxisSize + 1 || largeTitleSize <= smallTitleSize + 1 || largeTooltipSize <= smallTooltipSize + 1) failures.push("plot type did not adapt to the display size");
  await fetch("/__result?payload=" + encodeURIComponent(JSON.stringify({ failures, cursorPositions: new Set(cursorPositions).size })));
})().catch(async (error) => fetch("/__result?payload=" + encodeURIComponent(JSON.stringify({ failures: [String(error.stack || error)] }))));`;

const syntaxProbe = readFileSync(pagePath, "utf8").replace("</script>", `${injected}</script>`).match(/<script>([\s\S]*)<\/script>/);
new Function(syntaxProbe[1]);

let finish;
const result = new Promise((resolve) => { finish = resolve; });
const mime = { ".html": "text/html", ".otf": "font/otf" };
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/__result") {
    response.end("ok");
    return finish(JSON.parse(url.searchParams.get("payload")));
  }
  const relative = url.pathname === "/" ? "ncx/ui-prototype.html" : url.pathname.slice(1);
  const path = normalize(join(root, relative));
  let isFile = false;
  try { isFile = statSync(path).isFile(); } catch {}
  if (!path.startsWith(`${root}/`) || !isFile) {
    response.statusCode = 404;
    return response.end("not found");
  }
  let body = readFileSync(path);
  if (path === pagePath) body = Buffer.from(body.toString().replace("</script>", `${injected}</script>`));
  response.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream");
  response.end(body);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const profile = await mkdtemp(join(tmpdir(), "ncx-ui-test-"));
const browser = spawn("firefox", ["--headless", "--no-remote", "--profile", profile, `http://127.0.0.1:${port}/ncx/ui-prototype.html`], { stdio: "ignore" });
const payload = await Promise.race([
  result,
  new Promise((resolve) => setTimeout(() => resolve({ failures: ["browser check timed out"] }), 10000)),
]);
browser.kill("SIGTERM");
server.close();
await rm(profile, { recursive: true, force: true });
console.log(JSON.stringify(payload, null, 2));
process.exitCode = payload.failures.length ? 1 : 0;
