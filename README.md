# ncx

`ncx` is a thin, read-only NetCDF viewer. It serves one file on IPv4 loopback,
embeds its browser UI in the Rust executable, and can run beside remote data
through an SSH local forward.

```bash
ncx open run.nc
ncx open cluster:/absolute/path/run.nc
ncx serve --port 8765 run.nc
```

The UI browses groups and metadata; draws plain, rectilinear, curvilinear, and
UGRID 2-D fields; plots one-dimensional curves; animates indexed dimensions;
supports probes, locked colour ranges, box zoom, and PNG export. OSM tiles are
an optional user-selected reference layer. Plot views preserve coordinate
aspect, provide button zoom/reset and middle-button panning, and hide UGRID
geometry variables by default. WGS84 azimuthal-equidistant meshes report probes
as latitude/longitude without a projection-library dependency; projected meshes
use their CF longitude/latitude coordinate arrays when present. Files are never
modified.

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
```

The browser checks require Firefox and bind temporary loopback ports.
