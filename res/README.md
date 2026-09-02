# res/

Fonts the `ncx` binary embeds at compile time. The viewer's usual home is an
SSH tunnel to a cluster with no route to a CDN, so everything it needs to draw
itself has to be inside the executable.

| Directory | Face | Job | Licence | In git |
|---|---|---|---|---|
| `AVHershey/` | AVHershey Simplex | plot glyphs, matching the project's printed figures | WTFPL v2 | yes |
| `AVHershey/NationalPark.woff2` | National Park | plot fallback and chrome labels | SIL OFL 1.1 | yes |
| `gorton-perfected-1.02/` | Gorton Perfected | interface text | commercial, per-seat | **no** |
| `gen/` | Gorton Perfected, subset | what actually ships | same as above | **no** |
| `CommitMono/commit-*.woff2` | Commit Mono, subset | every variable name, value, coordinate and unit | SIL OFL 1.1 | yes |
| `CommitMono/src/` | Commit Mono, hinted TrueType | source for the cut above | SIL OFL 1.1 | **no** |
| `NewCM/` | New Computer Modern Math | every mathematical symbol, in any face | SIL OFL 1.1 | yes |

Nothing is loaded from a CDN. Commit Mono used to be, which put the one face
whose entire job is column alignment behind the one dependency this binary
cannot satisfy — so it was missing precisely where the viewer normally runs.

`NewCM/` is mounted by `unicode-range`, not by markup: it leads every font stack
in `style.css` carrying Greek, arrows and the operator block, and font matching
runs per character. That sets every Greek letter and operator in LaTeX's face
wherever it appears, including inside SVG plot labels, with no wrapper element.
It also fills a real hole — Gorton carries no lowercase Greek and no
superscripts at all.

## Why some of these are gitignored

Gorton Perfected is licensed for use, not redistribution. The terms are
explicit that a subset does not escape them:

> **MODIFICATIONS:** You may also subset and modify the font software itself
> for your own purposes; any derived versions of the font remain my property
> and are subject to the same license and limitations.

> **DISTRIBUTION:** Except in very specific instances described and permitted
> in this license, you may not distribute (share, rent, lend, give away, or
> sell) the font. You agree to take all reasonable steps to prevent unlicensed
> users from accessing, distributing, or re-serving the font file.

Committing `gen/` would distribute the font to everyone who clones. So both the
source and the subsets stay out of the repository, and the subset exists only
inside a binary built by someone holding a licence. `FORMATS` permits WOFF2,
which is what is served.

`CommitMono/src/` is gitignored for the opposite reason — no licence problem at
all, just weight. The upstream `ttfautohint` sources total 745 kB; the two WOFF2
cuts total 48 kB. The hinted TrueType build is deliberate: Commit Mono's CFF OTF
has no grid-fitting tables, while this source carries `gasp`, `fpgm`, `prep` and
`cvt ` through to WOFF2 for small fractional sizes on Windows.

## Building without a licence

`cargo build` works either way. `build.rs` covers three cases:

1. **licensed source present, fontTools available** — subsets it now;
2. **no fontTools, but `gen/` holds subsets from an earlier run** — uses those;
3. **no licensed source** — emits empty files and prints a build warning. The
   `@font-face` then fails to load and `style.css` falls through to the
   platform sans, per glyph. The viewer is fully usable; it is wearing a
   different face.

## Regenerating the subset

Needs `pip install fonttools brotli`. `build.rs` runs this for you; call it
directly only to inspect the output.

```bash
python3 web/scripts/subset-fonts.py
```

It cuts five files to one declared character set:

```
GortonPerfected-Regular.otf     42.5 kB -> gorton-400.woff2    18.1 kB
GortonPerfected-Semibold.otf    42.9 kB -> gorton-600.woff2    18.3 kB
CommitMono-400-Regular.ttf     369.1 kB -> commit-400.woff2    24.1 kB
CommitMono-700-Regular.ttf     375.8 kB -> commit-700.woff2    23.9 kB
NationalPark-Regular.ttf        74.6 kB -> NationalPark.woff2  14.8 kB
```

A missing source is skipped rather than fatal, and the existing output stands.
That is what lets a clone without a Gorton licence still re-cut Commit Mono, and
a licensed clone re-cut Gorton without carrying Commit Mono's TTFs.

All three families get the same set, because any can be handed the same
`long_name`, and a units string that drops out of Commit Mono mid-word loses the
column alignment it is carried for. The set is declared rather than scraped: the chrome
is fixed and could be scanned, but variable names, units and `long_name`
attributes come out of whatever file the reader opens and could hold anything.
So it covers Latin, Latin-1, Latin Extended-A, Greek, super/subscripts, arrows
and the scientific punctuation CF metadata reaches for. Anything outside falls
through the stack.

Gorton keeps `kern,tnum,zero,ss02,ss04,ss06,ss12`; Commit Mono keeps
`cv03,ss05`; National Park keeps `kern`. Commit Mono's smart kerning moves
glyphs within fixed advances, so columns remain monospaced. Its `calt` and
ligatures are dropped deliberately: `->` inside a `long_name` is two
characters, not an arrow.
