/**
 * Regenerate `src/scm.ts` from the project style's embedded colour map data.
 *
 *     node scripts/sync-colormaps.mjs
 *
 * The Scientific colour maps live in `Style/plotstyle/_scm.py`, which is the
 * single source for the whole project. Reading them from there rather than
 * re-typing them here is the point: a figure in a paper and the same field in
 * this viewer have to be the same colour, and two hand-maintained copies of a
 * 256-entry table will not stay that way.
 *
 * Node is already required to build the web assets, so this adds no toolchain.
 * The generated file is committed, so a plain `npm ci && npm run build` never
 * needs the Python side present.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, "../../../Style/plotstyle/_scm.py");
const TARGET = resolve(here, "../src/scm.ts");
const LEGACY_SOURCE = resolve(here, "../../../lib/ushow/src/cmocean_colormaps.h");
const LEGACY_TARGET = resolve(here, "../src/ncview_legacy.ts");

/**
 * Maps carried into the browser. A deliberately short list: every entry is one
 * the viewer can *choose on its own* from CF metadata, and an entry nothing
 * selects is a colour map someone picks by eye, which is the habit the whole
 * scheme exists to break. See `src/color.ts` for what selects what.
 */
const WANTED = [
  "batlow", // sequential default
  "lajolla", // sequential, thermal
  "oslo", // sequential, reversed for depth
  "bilbao", // sequential, reversed for stress and other intensities
  "grayC", // sequential, neutral
  "vik", // diverging
  "berlin", // diverging, dark midpoint, for the dark canvas
  "oleron", // multi-sequential, topography about sea level
  "romaO", // cyclic, phase and direction
];

/** `NAME = ( "AABBCC AABBCC " ... ).split()` -> ["AABBCC", ...]. */
function readTable(python, name) {
  const match = python.match(
    new RegExp(`^${name.toUpperCase()} = \\(\\n([\\s\\S]*?)\\)\\.split\\(\\)`, "m"),
  );
  if (!match) throw new Error(`${name} not found in ${SOURCE}`);
  const entries = match[1].match(/[0-9A-F]{6}/g) ?? [];
  if (entries.length !== 256) {
    throw new Error(`${name} has ${entries.length} entries, expected 256`);
  }
  return entries;
}

const python = readFileSync(SOURCE, "utf8");
const classes = Object.fromEntries(
  [...python.matchAll(/^ {4}"([a-zA-Z]+)": "([a-z-]+)",$/gm)].map((m) => [m[1], m[2]]),
);

const lines = [
  "/**",
  " * Scientific colour map data -- generated, do not hand-edit.",
  " *",
  " * Fabio Crameri's Scientific colour maps, the same tables the project's",
  " * Python figures use, so a field drawn here and the same field drawn for a",
  " * paper are the same colour. Cite the maps, not this file:",
  " *",
  " *   Crameri, F. (2018). Scientific colour maps. Zenodo.",
  " *   https://doi.org/10.5281/zenodo.1243862",
  " *",
  " *   Crameri, F., Shephard, G. E. & Heron, P. J. (2020). The misuse of colour",
  " *   in science communication. Nature Communications 11, 5444.",
  " *",
  " * Each map is the full 256-entry table, not a handful of stops. Interpolating",
  " * a perceptually uniform map between five widely spaced stops in sRGB throws",
  " * away the uniformity that is the entire reason to use it -- the ramp comes",
  " * back with flat stretches and false edges. 256 entries cost about a kilobyte",
  " * each after compression, which is cheaper than being wrong.",
  " *",
  " * Regenerate with `node scripts/sync-colormaps.mjs`.",
  " */",
  "",
  "/** Crameri's classification, which decides how a map may legitimately be used. */",
  'export type ScmClass = "sequential" | "diverging" | "multi-sequential" | "cyclic";',
  "",
  "export const SCM_CLASS = {",
];
for (const name of WANTED) lines.push(`  ${name}: "${classes[name]}",`);
lines.push("} as const satisfies Record<string, ScmClass>;", "");
lines.push("export type ScmName = keyof typeof SCM_CLASS;", "");
lines.push("/** name -> 256 packed RRGGBB entries, low value first. */");
lines.push("export const SCM: Record<ScmName, string> = {");
for (const name of WANTED) {
  const table = readTable(python, name).join("");
  lines.push(`  ${name}:`);
  for (let i = 0; i < table.length; i += 96) {
    const chunk = table.slice(i, i + 96);
    lines.push(`    "${chunk}"${i + 96 >= table.length ? "," : " +"}`);
  }
}
lines.push("};", "");

writeFileSync(TARGET, lines.join("\n"));
const bytes = readFileSync(TARGET).length;
console.log(`wrote ${TARGET} (${(bytes / 1024).toFixed(1)} kB, ${WANTED.length} maps)`);

const LEGACY_CLASSES = {
  viridis: "sequential",
  hot: "sequential",
  grayscale: "sequential",
  algae: "sequential",
  amp: "sequential",
  balance: "diverging",
  curl: "diverging",
  deep: "sequential",
  delta: "diverging",
  dense: "sequential",
  diff: "diverging",
  gray: "sequential",
  haline: "sequential",
  ice: "sequential",
  matter: "sequential",
  oxy: "sequential",
  phase: "cyclic",
  rain: "sequential",
  solar: "sequential",
  speed: "sequential",
  tarn: "diverging",
  tempo: "sequential",
  thermal: "sequential",
  topo: "multi-sequential",
  turbid: "sequential",
};

const legacySource = readFileSync(LEGACY_SOURCE, "utf8");
const cmoceanNames = [...legacySource.matchAll(/\{"([a-z]+)", cmocean_[a-z]+\}/g)]
  .map((match) => match[1]);
const legacyNames = ["viridis", "hot", "grayscale", ...cmoceanNames];

function readCmoceanTable(name) {
  const match = legacySource.match(new RegExp(
    `static const unsigned char cmocean_${name}\\[256\\]\\[3\\] = \\{([\\s\\S]*?)\\n\\};`,
  ));
  if (!match) throw new Error(`${name} not found in ${LEGACY_SOURCE}`);
  const entries = [...match[1].matchAll(/\{\s*(\d+),\s*(\d+),\s*(\d+)\s*\}/g)]
    .map((entry) => entry.slice(1).map(Number));
  if (entries.length !== 256) {
    throw new Error(`${name} has ${entries.length} entries, expected 256`);
  }
  return entries;
}

const f32 = Math.fround;
const add = (left, right) => f32(f32(left) + f32(right));
const multiply = (left, right) => f32(f32(left) * f32(right));
const byte = (value) => Math.trunc(multiply(Math.max(0, Math.min(1, value)), 255));

function builtInTable(name) {
  return Array.from({ length: 256 }, (_, index) => {
    if (name === "grayscale") return [index, index, index];
    const t = f32(index / 255);
    if (name === "hot") {
      if (t < f32(0.33333)) return [byte(multiply(t, 3)), 0, 0];
      if (t < f32(0.66667)) {
        return [255, byte(multiply(add(t, -0.33333), 3)), 0];
      }
      return [255, 255, byte(multiply(add(t, -0.66667), 3))];
    }
    if (name !== "viridis") throw new Error(`unknown built-in uShow map ${name}`);
    const r = add(0.267004, multiply(t, add(0.282327, multiply(t, add(-0.605696, multiply(t, 1.049613))))));
    const g = add(0.004874, multiply(t, add(1.421801, multiply(t, add(-0.759744, multiply(t, 0.239226))))));
    const b = add(0.329415, multiply(t, add(0.266658, multiply(t, add(0.123926, multiply(t, -0.576063))))));
    return [byte(r), byte(g), byte(b)];
  });
}

const legacyTables = Object.fromEntries(legacyNames.map((name) => [
  name,
  ["viridis", "hot", "grayscale"].includes(name) ? builtInTable(name) : readCmoceanTable(name),
]));
const hex = (table) => table
  .flat()
  .map((value) => value.toString(16).padStart(2, "0").toUpperCase())
  .join("");
const legacyLines = [
  "/**",
  " * uShow/ncview legacy colour maps -- generated, do not hand-edit.",
  " *",
  " * Imported from `lib/ushow/src/colormaps.c` and its embedded cmocean",
  " * tables. These maps are opt-in compatibility choices; ncx's metadata-driven",
  " * defaults remain the Scientific colour maps in `scm.ts`.",
  " *",
  " * Regenerate with `node scripts/sync-colormaps.mjs`.",
  " */",
  "",
  'import type { ScmClass } from "./scm.ts";',
  "",
  `export const NCVIEW_LEGACY_NAMES = ${JSON.stringify(legacyNames)} as const;`,
  "export type NcviewLegacyName = typeof NCVIEW_LEGACY_NAMES[number];",
  "",
  "export const NCVIEW_LEGACY_CLASS = {",
];
for (const name of legacyNames) {
  const kind = LEGACY_CLASSES[name];
  if (!kind) throw new Error(`no class for legacy map ${name}`);
  legacyLines.push(`  ${name}: "${kind}",`);
}
legacyLines.push("} as const satisfies Record<NcviewLegacyName, ScmClass>;", "");
legacyLines.push("/** name -> 256 packed RRGGBB entries, low value first. */");
legacyLines.push("export const NCVIEW_LEGACY: Record<NcviewLegacyName, string> = {");
for (const name of legacyNames) {
  const table = hex(legacyTables[name]);
  legacyLines.push(`  ${name}:`);
  for (let index = 0; index < table.length; index += 96) {
    const chunk = table.slice(index, index + 96);
    legacyLines.push(`    "${chunk}"${index + 96 >= table.length ? "," : " +"}`);
  }
}
legacyLines.push("};", "");

writeFileSync(LEGACY_TARGET, legacyLines.join("\n"));
const legacyBytes = readFileSync(LEGACY_TARGET).length;
console.log(`wrote ${LEGACY_TARGET} (${(legacyBytes / 1024).toFixed(1)} kB, ${legacyNames.length} maps)`);
