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
