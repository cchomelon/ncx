/**
 * The LaTeX subset a scientific axis title actually contains.
 *
 * Style/design.md § Micro-typography asks for `m s⁻¹` rather than `m/s`, and
 * for Greek where the quantity is Greek. That is superscripts, subscripts, a
 * few operators and the Greek alphabet -- not fractions, roots or matrices. So
 * this is a tokeniser, not a typesetter, and it needs no dependency: the whole
 * subset resolves to Unicode plus a baseline shift.
 *
 * ponytail: no KaTeX. It emits HTML+CSS, which the SVG export cannot use
 * without a second render path, and it costs ~280 kB in a binary that embeds
 * its whole UI. Reach for it only when someone needs a real fraction in an
 * axis title.
 */

/** A run of text at one baseline. `shift` is in em of the surrounding size. */
export interface MathRun {
  text: string;
  /** 0 on the baseline, positive up (superscript), negative down (subscript). */
  shift: number;
  /** Size relative to the surrounding type. */
  scale: number;
}

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
  nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
  upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·", degree: "°",
  circ: "°", approx: "≈", neq: "≠", leq: "≤", geq: "≥",
  partial: "∂", nabla: "∇", infty: "∞", propto: "∝", sim: "∼",
  langle: "⟨", rangle: "⟩", perthousand: "‰", permil: "‰",
};

/** Superscript and subscript sit at Style's own modular step below the body. */
const SCRIPT_SCALE = 0.75;
const SUPERSCRIPT_SHIFT = 0.42;
const SUBSCRIPT_SHIFT = -0.2;

/**
 * Split `source` into baseline runs.
 *
 * `^{...}` and `_{...}` take a braced group or the single next character, so
 * both `m s^{-1}` and `x^2` work. `\name` becomes its symbol; an unknown name
 * is left as typed rather than silently dropped, so a typo is visible.
 */
export function parseMath(source: string): MathRun[] {
  const runs: MathRun[] = [];
  let plain = "";
  let index = 0;
  const flush = () => {
    if (plain) runs.push({ text: plain, shift: 0, scale: 1 });
    plain = "";
  };
  while (index < source.length) {
    const character = source[index];
    if ((character === "^" || character === "_") && index + 1 < source.length) {
      let body: string;
      if (source[index + 1] === "{") {
        const close = source.indexOf("}", index + 2);
        if (close === -1) {
          plain += character;
          index += 1;
          continue;
        }
        body = source.slice(index + 2, close);
        index = close + 1;
      } else {
        body = source[index + 1];
        index += 2;
      }
      flush();
      runs.push({
        text: expandSymbols(body),
        shift: character === "^" ? SUPERSCRIPT_SHIFT : SUBSCRIPT_SHIFT,
        scale: SCRIPT_SCALE,
      });
      continue;
    }
    if (character === "\\") {
      const match = /^\\([A-Za-z]+)/.exec(source.slice(index));
      if (match && SYMBOLS[match[1]]) {
        plain += SYMBOLS[match[1]];
        index += match[0].length;
        continue;
      }
    }
    plain += character;
    index += 1;
  }
  flush();
  return runs;
}

function expandSymbols(source: string): string {
  return source.replace(/\\([A-Za-z]+)/g, (whole, name: string) => SYMBOLS[name] ?? whole);
}

/** True when `source` carries markup worth parsing. */
export function hasMath(source: string): boolean {
  return /[\^_\\]/.test(source);
}

/**
 * Plain-text form, for a `title` attribute or a filename.
 *
 * Digits and the minus sign get real Unicode superscripts where they exist, so
 * a tooltip reads `m s⁻¹` rather than `m s^{-1}`.
 */
const SUPERSCRIPT_GLYPHS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "-": "⁻", "+": "⁺", "(": "⁽", ")": "⁾",
};

export function mathToText(source: string): string {
  return parseMath(source)
    .map((run) => {
      if (run.shift <= 0) return run.text;
      const glyphs = [...run.text].map((character) => SUPERSCRIPT_GLYPHS[character]);
      return glyphs.every(Boolean) ? glyphs.join("") : `^${run.text}`;
    })
    .join("");
}
