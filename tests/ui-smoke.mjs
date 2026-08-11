import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ncx = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(ncx, "target/debug/ncx");
const browserMode = process.argv[2] ?? "rectilinear";
if (!["rectilinear", "curvilinear", "ugrid", "ugrid_projected"].includes(browserMode)) {
  throw new Error(`unknown browser fixture ${JSON.stringify(browserMode)}`);
}
const fixture = join(ncx, `tests/data/${browserMode}.nc`);

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
const axisText = () => [...document.querySelectorAll(".plot-axis text")].map((node) => node.textContent).join("|");
const hasCorrectAspect = (canvas) => {
  const labels = [...document.querySelectorAll(".plot-axis > g text")]
    .map((node) => Number(node.textContent.replaceAll(",", "")));
  if (labels.length < 10 || labels.some((value) => !Number.isFinite(value))) return false;
  const dataAspect = Math.abs((labels[4] - labels[0]) / (labels[9] - labels[5]));
  const bounds = canvas.getBoundingClientRect();
  return Math.abs(dataAspect / (bounds.width / bounds.height) - 1) < 0.04;
};
const failures = [];
try {
  window.__ncxStep = "initial field";
  const shell = await waitFor(() => document.querySelector(".shell"), "application shell did not mount");
  if (browserMode !== "rectilinear") {
    const canvas = await waitFor(() => {
      const node = document.querySelector(".mesh-canvas[data-rendered='true']");
      return node && !document.querySelector(".plot-loading") ? node : null;
    }, "mesh field did not render");
    if (document.querySelector(".plot-error")) failures.push(document.querySelector(".plot-error").textContent);
    const expectedKind = browserMode.startsWith("ugrid") ? "ugrid2d" : browserMode;
    if (!document.querySelector(".figure-head span")?.textContent.includes(expectedKind)) failures.push("mesh view kind is missing");

    if (browserMode.startsWith("ugrid")) {
      const visibleVariables = [...document.querySelectorAll(".variable-row span")].map((row) => row.textContent);
      if (visibleVariables.some((name) => /^Mesh2D(?:_|$)/.test(name))) {
        failures.push("Mesh2D geometry variables were not filtered by default: " + visibleVariables.join(", "));
      }
    }

    window.__ncxStep = "mesh zoom";
    const beforeZoom = axisText();
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
    await waitFor(() => axisText() !== beforeZoom, "mesh box zoom did not update axes");
    if (!hasCorrectAspect(canvas)) failures.push("mesh box zoom stretched the coordinate aspect");
    const beforePan = axisText();
    pointer("pointerdown", 0.5, 0.5, { button: 1, buttons: 4 });
    pointer("pointermove", 0.6, 0.55, { button: 1, buttons: 4 });
    pointer("pointerup", 0.6, 0.55, { button: 1 });
    await waitFor(() => axisText() !== beforePan, "middle-button mesh pan did not update axes");
    document.querySelector('button[title="Reset view"]').click();
    await waitFor(() => axisText() === beforeZoom, "mesh Reset view did not restore the full extent");
    document.querySelector('button[title="Zoom in"]').click();
    await waitFor(() => axisText() !== beforeZoom, "mesh Zoom in did not update axes");
    document.querySelector('button[title="Zoom out"]').click();
    await waitFor(() => axisText() === beforeZoom, "mesh Zoom out did not restore the previous extent");
    pointer("pointerdown", 0.25, 0.25);
    pointer("pointermove", 0.75, 0.75);
    pointer("pointerup", 0.75, 0.75);
    await waitFor(() => axisText() !== beforeZoom, "mesh persistence zoom did not update axes");
    const meshViewBeforeTab = axisText();

    window.__ncxStep = "mesh probe";
    pointer("pointerdown", 0.5, 0.5);
    pointer("pointerup", 0.5, 0.5);
    await waitFor(() => document.querySelector(".probe-mark"), "mesh probe did not appear");
    if (!/°[NS].*°[EW]/.test(document.querySelector(".statusbar span:last-child")?.textContent ?? "")) failures.push("mesh probe status did not use latitude then longitude");
    if (!/°[NS].*°[EW]/.test(document.querySelector(".figure-head span")?.textContent ?? "")) failures.push("mesh probe subtitle did not use latitude then longitude");
    [...document.querySelectorAll(".view-tabs button")].find((button) => button.textContent === "Curve").click();
    await waitFor(() => document.querySelector(".curve-line")?.getAttribute("d"), "mesh probe curve did not render");
    if (!document.querySelector(".axis-label")?.textContent.includes("Time (UTC)")) failures.push("mesh curve lost CF time");
    [...document.querySelectorAll(".view-tabs button")].find((button) => button.textContent === "Field").click();
    await waitFor(() => document.querySelector(".mesh-canvas[data-rendered='true']") && !document.querySelector(".plot-loading"), "mesh Field view did not return");
    if (axisText() !== meshViewBeforeTab) failures.push("mesh zoom reset after Curve → Field tab switch");

    if (browserMode === "ugrid") {
      window.__ncxStep = "UGRID face field";
      [...document.querySelectorAll(".variable-row")]
        .find((button) => button.textContent.includes("face_depth"))?.click();
      await waitFor(() => document.querySelector(".mesh-location")?.textContent.includes("face") && document.querySelector(".mesh-canvas[data-rendered='true']"), "UGRID face field did not render");
    }
    if (shell !== document.querySelector(".shell")) failures.push("mesh interactions replaced the application shell");
  } else {
  const canvas = await waitFor(() => {
    const node = document.querySelector(".field-canvas");
    return node && node.width > 1 && !document.querySelector(".plot-loading") ? node : null;
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
  const axisBeforeZoom = axisText();
  fieldPointer("pointerdown", 0.2, 0.2);
  fieldPointer("pointermove", 0.8, 0.8);
  fieldPointer("pointerup", 0.8, 0.8);
  await waitFor(() => axisText() !== axisBeforeZoom, "field box zoom did not update axes");
  if (!hasCorrectAspect(canvas)) failures.push("field box zoom stretched the coordinate aspect");
  const fieldBeforePan = axisText();
  fieldPointer("pointerdown", 0.5, 0.5, { button: 1, buttons: 4 });
  fieldPointer("pointermove", 0.6, 0.55, { button: 1, buttons: 4 });
  fieldPointer("pointerup", 0.6, 0.55, { button: 1 });
  await waitFor(() => axisText() !== fieldBeforePan, "middle-button field pan did not update axes");
  document.querySelector('button[title="Reset view"]').click();
  await waitFor(() => axisText() === axisBeforeZoom, "field Reset view did not restore the full extent");
  document.querySelector('button[title="Zoom in"]').click();
  await waitFor(() => axisText() !== axisBeforeZoom, "field Zoom in did not update axes");
  document.querySelector('button[title="Zoom out"]').click();
  await waitFor(() => axisText() === axisBeforeZoom, "field Zoom out did not restore the previous extent");
  fieldPointer("pointerdown", 0.25, 0.25);
  fieldPointer("pointermove", 0.75, 0.75);
  fieldPointer("pointerup", 0.75, 0.75);
  await waitFor(() => axisText() !== axisBeforeZoom, "field persistence zoom did not update axes");
  const fieldViewBeforeTab = axisText();
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
  await waitFor(() => document.querySelector(".field-canvas") && !document.querySelector(".plot-loading"), "Field view did not return");
  if (axisText() !== fieldViewBeforeTab) failures.push("field zoom reset after Curve → Field tab switch");
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

const child = spawn(binary, ["serve", "--port", "0", fixture], {
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
const proxy = createServer(async (request, response) => {
  proxyHits += 1;
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/__result") {
    response.end("ok");
    finish(JSON.parse(url.searchParams.get("payload")));
    return;
  }
  try {
    const upstream = await fetch(`http://127.0.0.1:${upstreamPort}${request.url}`);
    let body = Buffer.from(await upstream.arrayBuffer());
    if (url.pathname === "/") {
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
  ["--headless", "-no-remote", "-profile", profile, `http://127.0.0.1:${proxyPort}/`],
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
