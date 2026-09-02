/**
 * Print-ready PNG export.
 *
 * The old export drew the field canvas and nothing else, because the axes,
 * colourbar and labels are not in that canvas -- they are an SVG overlay
 * stacked on top of it. You got the pixels with no scale, no colourbar and no
 * units, which is not a figure. On a UGRID mesh you got a blank rectangle
 * instead, because the WebGL context had no `preserveDrawingBuffer` and the
 * compositor had already cleared it by the time `toDataURL` ran.
 *
 * So this composes the whole thing: the raster, the furniture over it, and the
 * title band above, into one SVG rendered at print resolution.
 *
 * Style/Guidance.md §10 is the standard being met. PNG at 400 dpi is the
 * deliverable; the fonts are embedded rather than named, because an SVG
 * rasterised through an `<img>` is an isolated document that cannot see this
 * page's stylesheet or its webfonts, and a named-but-absent face silently
 * becomes the platform sans -- which is exactly the substitution the project's
 * style rules exist to prevent.
 */

/** Style's print resolution. */
export const EXPORT_DPI = 400;
/** The resolution a CSS pixel is defined against. */
const CSS_DPI = 96;

/**
 * Presentation properties worth carrying into the isolated SVG document.
 *
 * Copying the *computed* value of each is what makes this robust: the export
 * cannot drift from the stylesheet, because it never restates a rule.
 */
const CARRIED = [
  "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
  "text-anchor", "dominant-baseline", "opacity", "visibility", "display",
] as const;

/** Faces the plot can set: AVHershey, National Park behind it per glyph, and
 *  CM Math ahead of both for Greek, arrows and operators. */
const FONT_FILES = [
  { family: "AVHershey Simplex", weight: 400, url: "/fonts/hershey-medium.woff2" },
  { family: "AVHershey Simplex", weight: 700, url: "/fonts/hershey-heavy.woff2" },
  { family: "National Park", weight: 400, url: "/fonts/nationalpark.woff2" },
  // CM Math leads --plot-face, so the copied computed `font-family` names it on
  // every text node here. It has to carry its unicode-range too: without one it
  // would claim Latin as well, and its subset has no Latin to answer with.
  { family: "CM Math", weight: 400, url: "/fonts/cmmath.woff2",
    range: "U+00B1, U+00D7, U+00F7, U+0370-03FF, U+2190-21FF, U+2200-22FF" },
];

let fontCache: string | undefined;

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` overflows the argument limit on a
  // font-sized array.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function embeddedFontCss(): Promise<string> {
  if (fontCache !== undefined) return fontCache;
  const faces = await Promise.all(FONT_FILES.map(async (font) => {
    try {
      const response = await fetch(font.url);
      if (!response.ok) return "";
      const data = base64(await response.arrayBuffer());
      return `@font-face{font-family:"${font.family}";font-weight:${font.weight};`
        + (font.range ? `unicode-range:${font.range};` : "")
        + `src:url(data:font/woff2;base64,${data}) format("woff2")}`;
    } catch {
      return "";
    }
  }));
  fontCache = faces.join("");
  return fontCache;
}

/** Walk both trees in step, copying computed presentation onto the clone. */
function inlineComputedStyle(source: Element, clone: Element): void {
  const computed = getComputedStyle(source);
  let declaration = "";
  for (const property of CARRIED) {
    const value = computed.getPropertyValue(property);
    if (value) declaration += `${property}:${value};`;
  }
  clone.setAttribute("style", declaration);
  const sourceChildren = source.children;
  const cloneChildren = clone.children;
  for (let index = 0; index < sourceChildren.length; index += 1) {
    inlineComputedStyle(sourceChildren[index], cloneChildren[index]);
  }
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

/** Title and subtitle for the band, read from the figure's own header. */
function figureHeading(): { title: string; subtitle: string } {
  const head = document.querySelector(".figure-head");
  return {
    title: head?.querySelector("h1")?.textContent?.trim() ?? "",
    subtitle: head?.querySelector("span")?.textContent?.trim() ?? "",
  };
}

/**
 * Save the plot on screen as a print-ready PNG.
 *
 * Everything visible in the panel comes along: the field or curve itself, the
 * axes and their units, the colourbar with the active colour scale and range,
 * and a title band naming the variable and the step.
 */
export async function exportPlotPng(name: string): Promise<void> {
  const frame = document.querySelector<HTMLElement>(".plot-frame");
  const source = frame?.querySelector<SVGSVGElement>("svg.plot-svg, svg.curve-svg");
  if (!frame || !source) throw new Error("The current view has no plot to save");

  const frameRect = frame.getBoundingClientRect();
  const width = Math.max(1, Math.round(frameRect.width));
  const plotHeight = Math.max(1, Math.round(frameRect.height));

  const heading = figureHeading();
  const titleSize = parseFloat(getComputedStyle(frame).getPropertyValue("--plot-title-size")) || 20;
  const subtitleSize = parseFloat(getComputedStyle(frame).getPropertyValue("--plot-subtitle-size")) || 14;
  const bandHeight = heading.title
    ? Math.round(titleSize * 1.5 + (heading.subtitle ? subtitleSize * 1.5 : 0))
    : 0;
  const height = plotHeight + bandHeight;

  const output = svgElement("svg");
  output.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  output.setAttribute("width", String(width));
  output.setAttribute("height", String(height));
  output.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const style = svgElement("style");
  style.textContent = await embeddedFontCss();
  output.append(style);

  const paper = svgElement("rect");
  paper.setAttribute("width", String(width));
  paper.setAttribute("height", String(height));
  paper.setAttribute("fill", "#ffffff");
  output.append(paper);

  if (heading.title) {
    // Centred here, and only here. On screen the title is left-aligned because
    // it heads a panel in a running interface and the eye picks it up on the
    // same left margin as everything else. An exported figure has no interface
    // around it: it is a plate, and a plate's caption centres on the plate.
    const face = getComputedStyle(frame).getPropertyValue("--plot-face") || "sans-serif";
    const centre = String(Math.round(width / 2));
    const title = svgElement("text");
    title.setAttribute("x", centre);
    title.setAttribute("y", String(Math.round(titleSize * 1.05)));
    title.setAttribute("text-anchor", "middle");
    title.setAttribute("style",
      `font-family:${face};font-size:${titleSize}px;font-weight:700;fill:#101418`);
    title.textContent = heading.title;
    output.append(title);
    if (heading.subtitle) {
      const subtitle = svgElement("text");
      subtitle.setAttribute("x", centre);
      subtitle.setAttribute("y", String(Math.round(titleSize * 1.05 + subtitleSize * 1.4)));
      subtitle.setAttribute("text-anchor", "middle");
      subtitle.setAttribute("style",
        `font-family:${face};font-size:${subtitleSize}px;fill:#4a5058`);
      subtitle.textContent = heading.subtitle;
      output.append(subtitle);
    }
  }

  const body = svgElement("g");
  body.setAttribute("transform", `translate(0 ${bandHeight})`);
  output.append(body);

  // The raster goes under the furniture, at the position the overlay's axes
  // were drawn for -- the canvas is absolutely placed inside the same frame,
  // so its offset is just the difference between the two rectangles.
  const canvas = frame.querySelector<HTMLCanvasElement>("canvas");
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    const image = svgElement("image");
    image.setAttribute("x", String(rect.left - frameRect.left));
    image.setAttribute("y", String(rect.top - frameRect.top));
    image.setAttribute("width", String(rect.width));
    image.setAttribute("height", String(rect.height));
    image.setAttribute("preserveAspectRatio", "none");
    image.setAttribute("href", canvas.toDataURL("image/png"));
    body.append(image);
  }

  const furniture = source.cloneNode(true) as SVGSVGElement;
  inlineComputedStyle(source, furniture);
  for (const child of Array.from(furniture.childNodes)) body.append(child);

  const scale = EXPORT_DPI / CSS_DPI;
  const raster = document.createElement("canvas");
  raster.width = Math.max(1, Math.round(width * scale));
  raster.height = Math.max(1, Math.round(height * scale));
  const context = raster.getContext("2d", { alpha: false });
  if (!context) throw new Error("The browser could not create an export canvas");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, raster.width, raster.height);

  const markup = new XMLSerializer().serializeToString(output);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    context.drawImage(image, 0, 0, raster.width, raster.height);
  } finally {
    URL.revokeObjectURL(url);
  }

  const png = await new Promise<Blob>((resolve, reject) => {
    raster.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))),
      "image/png",
    );
  });
  const download = URL.createObjectURL(png);
  const link = document.createElement("a");
  link.href = download;
  link.download = `${name.replace(/[^a-z0-9._-]+/gi, "_") || "ncx-plot"}.png`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(download), 0);
}
