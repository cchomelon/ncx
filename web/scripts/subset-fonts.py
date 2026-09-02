#!/usr/bin/env python3
"""Cut the interface and data faces down to the glyphs this viewer can set.

    python3 web/scripts/subset-fonts.py

Gorton Perfected is licensed for use, not for redistribution as a font: the
full file must not leave this machine. Serving `GortonPerfected-Regular.otf`
from the viewer would hand every reader a complete, installable copy of it.
So the binary never contains one. This script writes a subset carrying only
the characters below, and `src/server.rs` embeds *that*.

The subset is committed, like `web/dist/` and `src/scm.ts` before it, so a
plain `cargo build` never needs Python or fontTools present. Re-run this only
when the character set changes or the font is updated.

    pip install fonttools brotli

On the character set: the viewer's own chrome is fixed and scrapeable, but the
text it renders is not -- variable names, units and `long_name` attributes come
out of whatever NetCDF file the reader opens, and could hold anything. So the
set is declared rather than derived: everything the chrome uses, plus the Latin
and scientific ranges that CF metadata realistically reaches for. Anything
outside it falls through to the next family in the CSS stack, per glyph, which
is what a font stack is for. A missing glyph costs a substituted character; it
never costs a tofu box.

All three families are cut to the same set. Any of them can be asked to set a
`long_name`; a units string that drops out of Commit Mono mid-word loses the
column alignment Commit Mono is carried for.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GORTON = ROOT / "res/gorton-perfected-1.02/Font (not variable)"
COMMIT = ROOT / "res/CommitMono"
HERSHEY = ROOT / "res/AVHershey"
OUT = ROOT / "res/gen"

#: Gorton keeps seven OpenType features, Commit Mono keeps one.
#:
#: `tnum` and `zero` are what `font-variant-numeric: tabular-nums slashed-zero`
#: resolves to. Without them in the subset that declaration is inert, which is
#: what it was until now -- the cut kept `kern` and nothing else. The four
#: stylistic sets are single-glyph drafting forms, taken on `body`: ss02
#: straight-tailed Q, ss04 serifed I, ss06 alternate g, ss12 lowercase
#: ampersand. Gorton's ss01, which the foundry itself names "Not ugly variants",
#: is the opt-in cleanup of precisely the machine forms this interface wants,
#: so it is neither enabled nor subsetted in.
GORTON_FEATURES = "kern,tnum,zero,ss02,ss04,ss06,ss12"

#: (source, output, features).
#:
#: Gorton: 400 for text, 600 for the little that needs weight. Hierarchy here is
#: built from size, case, tracking and rules rather than weight (see style.css),
#: so two cuts is the whole range -- shipping seven would be six wasted payloads.
#:
#: Commit Mono is monospace, so tabular figures are inherent and it carries no
#: `tnum`/`zero` to keep. Its `calt` is programming ligatures, which a column of
#: values must not have: `->` inside a `long_name` is two characters, not an
#: arrow. Unlike Gorton it is SIL OFL, so its outputs are committed. The source
#: is the upstream `ttfautohint` TrueType build rather than the CFF OTF: the OTF
#: carries no grid-fitting tables, while the hinted TTF carries `gasp`, `fpgm`,
#: `prep` and `cvt ` for small fractional sizes on Windows. The source files are
#: gitignored under `res/CommitMono/src/` and are needed only to re-cut.
FACES = [
    (GORTON / "GortonPerfected-Regular.otf", OUT / "gorton-400.woff2", GORTON_FEATURES),
    (GORTON / "GortonPerfected-Semibold.otf", OUT / "gorton-600.woff2", GORTON_FEATURES),
    (COMMIT / "src/CommitMono-400-Regular.ttf", COMMIT / "commit-400.woff2", "kern,cv03"),
    (COMMIT / "src/CommitMono-700-Regular.ttf", COMMIT / "commit-700.woff2", "kern,cv03"),
    # National Park does two jobs, and was cut for only the first of them: it
    # backs AVHershey per glyph in the plots, so the original subset carried
    # exactly the ~200 characters an 89-glyph stroke font lacks -- punctuation,
    # accents, dashes -- and deliberately no A-Z, a-z or 0-9, because Hershey
    # already had those.
    #
    # Then it became --label-face, the signage face for every uppercase label in
    # the chrome, and there it is first in the stack rather than a fallback. A
    # face with no letters cannot set the word COLOUR. Every one of those labels
    # was falling past it to system-ui, which on Windows resolves to a CJK UI
    # face. Cutting it to the same set as the others fixes the labels and leaves
    # the fallback job untouched.
    (HERSHEY / "src/NationalPark-Regular.ttf", HERSHEY / "NationalPark.woff2", "kern"),
]


def ranges(*spans: tuple[int, int]) -> set[int]:
    out: set[int] = set()
    for lo, hi in spans:
        out.update(range(lo, hi + 1))
    return out


CHARSET: set[int] = (
    ranges((0x0020, 0x007E))          # basic latin
    | ranges((0x00A0, 0x00FF))        # latin-1: accents, degree, micro, plusminus
    | ranges((0x0100, 0x017F))        # latin extended-A, for European place names
    | ranges((0x0391, 0x03C9))        # greek, for symbols and units
    | ranges((0x2070, 0x209F))        # super/subscripts, for m s-1 and the like
    | ranges((0x2190, 0x2193))        # arrows
    | set(map(ord,
        "‘’“”"    # smart quotes
        "–—…′″‰"   # dashes, ellipsis, primes, permille
        "·•×÷±"         # interpunct, bullet, times, divide
        "≠≤≥≈∞√"   # relations and roots
        "∂∆∑∏∫"         # partial, delta, sum, product, integral
        "✓—"                   # check
        "†‡‹›‚„‖‐⁄€"   # daggers, single quotes, low quotes, bar, fraction slash
    ))
)


def main() -> int:
    unicodes = ",".join(f"U+{c:04X}" for c in sorted(CHARSET))
    cut = 0
    for source, target, features in FACES:
        # A missing source is not fatal. Gorton's is absent for anyone without a
        # licence, and Commit Mono's is absent in a fresh clone because only the
        # cut output is committed. In both cases the existing output stands.
        if not source.exists():
            print(f"no source, keeping {target.name}: {source}", file=sys.stderr)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                sys.executable, "-m", "fontTools.subset", str(source),
                f"--unicodes={unicodes}",
                "--flavor=woff2",
                f"--layout-features={features}",
                # Keep the name table minimal. It is metadata, not outlines, but
                # there is no reason to ship the foundry's full record either.
                "--name-IDs=1,2",
                f"--output-file={target}",
            ],
            check=True,
        )
        cut += 1
        before, after = source.stat().st_size, target.stat().st_size
        print(f"{source.name:34s} {before/1024:7.1f} kB -> {target.name} {after/1024:6.1f} kB")
    return 0 if cut else 1


if __name__ == "__main__":
    raise SystemExit(main())
