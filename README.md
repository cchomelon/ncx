# ncx

`ncx` is a thin, read-only NetCDF viewer. It serves one file, or an explicit
fixed set of named files, on IPv4 loopback; embeds its browser UI in the Rust
executable; and can run beside remote data through an SSH local forward.

```bash
ncx open run.nc
ncx open cluster:/absolute/path/run.nc
ncx serve --port 8765 run.nc
ncx serve --dataset case-a=/absolute/a.nc --dataset case-b=/absolute/b.nc
```

The UI browses groups and metadata; draws plain, rectilinear, curvilinear, and
UGRID 2-D node, edge, and face fields; plots one-dimensional curves; animates
indexed dimensions; supports probes, locked colour ranges, box zoom, and PNG export. OSM tiles are
an optional user-selected reference layer. Plot views preserve coordinate
aspect, label both axes and the colourbar with the CF quantity and unit, put
ticks on round numbers, and provide button zoom/reset and middle-button
panning. Time labels use UTC by default. An embedding application can add one
validated, fixed-offset display zone without changing the file.
A file opens on its most substantial data variable, and coordinate
and UGRID geometry variables are folded away by default. WGS84 azimuthal-equidistant meshes report probes
as latitude/longitude without a projection-library dependency; projected meshes
use their CF longitude/latitude coordinate arrays when present. Files are never
modified.

With named datasets, the browser can switch sources, overlay up to six
CF-compatible curves, or show up to four synchronized field panes. Matching uses
CF meaning, units, and explicit location identity; fields match absolute timestamps
within half a local source step and are never regridded. Curve offsets are
display-only. An embedded curve can request bounded generic comparison input
from its host by location, quantity, unit, and time extent; the host returns the
formatted series in a correlated browser message. HTTP stays NetCDF-only and
ncx never knows the provider. Hosted one-dimensional data stays in Curve and
adds the injected series there; an injected series can offer one primary
Y-offset preset without adding a second offset pair. Compare remains a
multi-dataset view.

## Style

The UI follows the project's plot style, adapted for a browser:
[Style.md](Style.md) records what carries over from [`Style/`](../Style/) and
what the web adds — type in rem rather than px, WCAG contrast floors, target
sizes, and colour maps chosen from each variable's CF metadata. The UI is the
light `plate` variant only, on purpose. Colour data is generated from the upstream tables with
`node web/scripts/sync-colormaps.mjs`, so a field here and the same field in a
paper are the same colour.

## Build

Requirements are Rust, Node.js, npm, and the NetCDF C library. Node.js is only
needed to build the embedded browser assets; the resulting executable does not
need Node.js or Python.

```bash
cd web
npm ci
npm run build
cd ..
cargo build --release
```

The fixed `web/dist/assets/app.js` and `app.css` names are intentional: Rust
embeds those files at compile time. Rebuild the web assets before compiling
Rust after a UI change.

For frontend development, start `ncx serve --port 8765 file.nc`, then run
`npm run dev` under `web/`; Vite forwards `/api` and the embedded font URLs.

## Checks

```bash
cd web && npm test && npm run build
cd .. && cargo test && cargo clippy --all-targets -- -D warnings
node tests/ui-smoke.mjs rectilinear
node tests/ui-smoke.mjs curvilinear
node tests/ui-smoke.mjs ugrid
node tests/ui-smoke.mjs ugrid_projected
node tests/ui-smoke.mjs comparison
```

The browser checks require Firefox and bind temporary loopback ports.
