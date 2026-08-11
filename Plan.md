# ncx implementation plan

Status: implemented; release candidate pending a real SSH-host smoke test

Source: [`Brainstorm.md`](Brainstorm.md)

## 1. Goal

Build `ncx`, a small remote-first NetCDF viewer for answering three questions quickly:

1. What datasets, groups, dimensions, variables, and attributes are in this file?
2. What does a selected one- or two-dimensional slice look like?
3. How does that slice or point change along another dimension?

The normal remote workflow is:

```bash
ncx open host:/data/run.nc
```

`ncx` starts a short-lived server beside the data, forwards it through SSH, and opens the browser. The server reads one NetCDF file, binds only to `127.0.0.1`, and exits with the CLI/SSH session. There is no persistent daemon, application login, HTTPS setup, path ACL, or gateway.

The deliverable is one Rust application with an embedded browser build. Node.js is a build dependency only. At runtime the application needs a browser, the `ncx` executable, the system SSH client for remote use, and the NetCDF C library used by the Rust `netcdf` crate.

## 2. Release boundary

### 0.1 scope

- Open local and SSH-addressed NetCDF files read-only.
- Browse datasets, nested NetCDF4 groups, dimensions, variables, and attributes.
- Select any variable and assign zero, one, or two dimensions to the display; use index controls for the remaining dimensions.
- Render scalar data in index space, on rectilinear coordinates, on curvilinear coordinates, or on a UGRID 2D mesh.
- Render UGRID node and face fields without silently converting one location to the other.
- Animate any indexed dimension without building a backlog of stale reads.
- Apply colormaps and manual or automatic ranges with linear, log, and symlog scaling.
- Mask `_FillValue`, `missing_value`, and non-finite values correctly, including packed variables using `scale_factor` and `add_offset`.
- Probe a rendered point and plot a one-dimensional curve through that point along a selected dimension.
- Save a screenshot and zoom by dragging a box.
- Request a strided preview while a selector is moving and a full-resolution slice after it settles.

### After 0.1

- Browser-side shoreline `.shp` loading.
- Contours.
- Vector overlays.
- Transects.
- Multi-file comparison.

The first four can be layered over the loaded view. Multi-file comparison changes the one-file session and API assumptions, so it requires a separate design before implementation.

### Explicit non-goals

- A canonical scientific-data model beyond the metadata needed by the UI.
- Full CF or UGRID conformance validation.
- General CRS transformation or map reprojection. The one supported inverse is a WGS84 `+proj=aeqd` root projection for latitude/longitude probe readouts.
- UGRID 1D/3D support, mesh partitioning, or automatic unstructured-mesh LOD.
- Server-side contours, rendering, statistics, or derived-variable execution.
- Python, xarray, Dask, VTK/VTK.js, PyVista, Arrow, Protobuf, WebSockets, a request planner, a representation graph, or a query planner.
- Docker as a build or runtime requirement.
- File editing, live-following a growing file, collaboration, saved sessions, or a persistent service.

## 3. Fixed design decisions

| Concern | Decision |
|---|---|
| Source of truth | The opened NetCDF file. Metadata returned to the UI stays thin. |
| Backend | Rust, Axum, Tokio, Serde, and `georust/netcdf`. |
| Frontend | TypeScript, React, native Canvas/SVG/WebGL2, and browser APIs. |
| Deployment | Frontend assets embedded in the Rust executable. |
| Server lifetime | One file and one user session per process. |
| Network exposure | Listen on IPv4 loopback only; remote access always crosses SSH. |
| HTTP surface | `GET /api/meta` and `GET /api/data`; other routes only serve the embedded application. |
| Read concurrency | Serialize NetCDF C reads through one file handle. |
| Display values | Convert numeric scalar and coordinate data to little-endian `Float32`. |
| Connectivity | Return UGRID connectivity as little-endian `Int32` or `Uint32`. |
| CF behavior | Detect useful defaults; never prevent the user from overriding display dimensions or coordinates. |
| Progressive loading | Structured-grid stride plus latest-request-wins; no generic LOD planner. |
| Geometry | Cache coordinates/connectivity in the browser and replace only scalar values during animation. |
| UGRID face data | Render as face-centered values; do not interpolate to nodes implicitly. |

## 4. User workflows

### Local file

```bash
ncx open /data/run.nc
```

The `open` process opens the file read-only, listens on an OS-assigned loopback port, opens the URL in the default browser, and remains the server until interrupted. If browser launching fails, it prints the URL and continues serving.

### Remote file

```bash
ncx open cluster:/data/run.nc
```

The local command:

1. Parses `cluster` as an SSH destination and `/data/run.nc` as an absolute remote path.
2. Selects candidate local and remote loopback ports.
3. Starts the system `ssh` client with `ExitOnForwardFailure=yes`, a local forward, and the remote command `ncx serve --port <remote-port> /data/run.nc`.
4. Waits until `GET /api/meta` succeeds through the tunnel.
5. Opens the forwarded local URL in the browser.
6. Owns the SSH child process and terminates it on Ctrl-C or normal exit.

Port-bind collisions are retried with a new pair of ports. Remote command arguments must be shell-quoted as data; do not concatenate an unchecked path into a shell command. Existing SSH configuration, including aliases and jump hosts, remains the user's responsibility.

The remote host must have a compatible `ncx` executable and NetCDF C library. Because the remote executable serves both the API and its embedded frontend, frontend/backend versions cannot drift.

### Explicit server mode

```bash
ncx serve --port 8765 /data/run.nc
```

This mode is for manual tunneling and debugging. It still binds only to `127.0.0.1`. `--port 0` asks the OS for a free port and prints a machine-readable readiness line followed by the browser URL.

## 5. Process architecture

```text
browser
  |  same-origin HTTP on localhost
  v
SSH local forward (remote files only)
  |
  v
ncx server: Axum -> serialized NetCDF reader -> NetCDF C -> run.nc
```

The server state contains one open dataset, its discovered metadata, a serialization lock for reads, and fixed safety limits. NetCDF reads are blocking, so handlers perform them with `spawn_blocking`; the Tokio request threads must not call NetCDF C directly.

The browser owns presentation state, the latest desired slice, cached static geometry, color settings, and camera state. The server does not keep per-view or per-variable rendering state.

## 6. Repository layout

Start with the following files and add another module only when a file has a distinct responsibility:

```text
ncx/
  Cargo.toml
  build.rs
  src/
    main.rs          # startup and error exit
    cli.rs           # open/serve commands, SSH, browser launch
    server.rs        # Axum routes, response headers, embedded files
    dataset.rs       # traversal, selection validation, reads, conversion
    cf.rs            # rectilinear, curvilinear, and UGRID hints
  web/
    package.json
    src/
      App.tsx
      api.ts
      model.ts
      selection.ts
      render.tsx
  tests/
    data/             # tiny committed NetCDF fixtures
```

Use React state and small pure functions first. Do not introduce a frontend state framework, plugin system, renderer interface hierarchy, or generic request-planning layer for 0.1.

The production build runs the frontend build first and embeds `web/dist` in the Rust binary. Development may run the frontend dev server with an `/api` proxy, but that server is never required in a packaged runtime.

## 7. Metadata model and discovery

`GET /api/meta` traverses the root and all nested groups once at startup. All group and variable identifiers exposed by the API are canonical absolute paths such as `/atmosphere/temperature`. Dimension records also carry a scoped path so equal dimension names in separate groups are not conflated.

A representative response is:

```json
{
  "dataset": { "name": "run.nc" },
  "limits": {
    "max_response_bytes": 268435456,
    "ugrid_warn_faces": 2000000
  },
  "groups": [
    { "path": "/", "name": "/" },
    { "path": "/atmosphere", "name": "atmosphere" }
  ],
  "dimensions": [
    {
      "path": "/atmosphere/time",
      "name": "time",
      "length": 241,
      "unlimited": true
    }
  ],
  "variables": [
    {
      "path": "/atmosphere/temperature",
      "name": "temperature",
      "dtype": "i16",
      "dimensions": [
        { "path": "/atmosphere/time", "name": "time", "length": 241 },
        { "path": "/atmosphere/level", "name": "level", "length": 20 },
        { "path": "/atmosphere/y", "name": "y", "length": 2000 },
        { "path": "/atmosphere/x", "name": "x", "length": 3000 }
      ],
      "attributes": [
        { "name": "units", "dtype": "string", "value": "K" },
        { "name": "scale_factor", "dtype": "f32", "value": 0.01 }
      ],
      "view_hint": {
        "kind": "curvilinear",
        "x": "/atmosphere/lon",
        "y": "/atmosphere/lat"
      }
    }
  ],
  "warnings": []
}
```

Attribute records remain typed. Scalar and short array attributes are returned directly; non-finite floating-point attribute values use string tokens (`"NaN"`, `"Infinity"`, and `"-Infinity"`) because JSON cannot represent them. Large attributes may be truncated with an explicit `truncated` flag rather than making metadata unbounded.

### Hint detection order

Detection provides the initial UI choice in this order:

1. **UGRID 2D**: the data variable's `mesh` attribute resolves to a variable with `cf_role = "mesh_topology"` and `topology_dimension = 2`; resolve `node_coordinates`, `face_node_connectivity`, `location`, `start_index`, fill padding, and the face dimension.
2. **Curvilinear**: the variable's `coordinates` attribute or CF axis metadata identifies numeric X/Y coordinate variables whose two dimensions match the chosen display dimensions.
3. **Rectilinear**: one-dimensional coordinate variables map independently to the two display dimensions.
4. **Plain**: render in index coordinates.

Resolve attribute references relative to the declaring group before trying an absolute path. A broken or ambiguous convention adds a metadata warning and falls back to `plain`; it does not make the dataset unusable.

For an undetected variable, default to the last two dimensions as display Y/X. Rank-one variables open as curves. Rank-zero variables show their value. Non-display selectors default to index zero, except an unlimited dimension defaults to its last currently visible index. The user can change display dimensions and coordinate variables at any time without changing the file or server state.

## 8. Data API contract

### Request

```http
GET /api/data?path=%2Fatmosphere%2Ftemperature&selection=120,4,0:2000,0:3000&stride=1,1,2,3
```

- `path` is one canonical variable path returned by `/api/meta`; it is never a filesystem path.
- `selection` has exactly one comma-separated item per variable dimension.
- An item is an integer index, `:`, or a half-open `start:stop` range.
- `stride` has exactly one positive integer per dimension. Stride for an integer-indexed dimension must be `1`.
- Indexed dimensions are omitted from the returned shape. Range dimensions remain in original order.

The server validates rank, integers, bounds, range order, stride, multiplication overflow, output element count, and estimated response bytes before allocating or calling NetCDF. Invalid requests return `400`. Requests above `max_response_bytes` return `413` with the stride needed to fit as a suggestion.

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
X-Ncx-Dtype: f32
X-Ncx-Shape: 1000,1000
X-Ncx-Endian: little
```

The body is one contiguous C-order typed array. Numeric scalar and coordinate variables return `f32`; variables identified as UGRID connectivity return `i32` or `u32`. Integer connectivity values that cannot be represented safely are rejected with a clear unsupported-data error.

All responses explicitly use little-endian byte order, independent of the server host. Scalar responses have an empty shape header. Empty slices are rejected in 0.1.

All primitive numeric variable types are eligible for `f32` display transport. The UI continues to show the stored dtype and warns that 64-bit integers may lose display precision. Character, string, enum, compound, opaque, and variable-length variables remain browseable as metadata but are not data-renderable in 0.1.

### Error response

API errors use an appropriate HTTP status and a small JSON body:

```json
{
  "error": {
    "code": "selection_out_of_bounds",
    "message": "dimension time has length 241; index 241 is invalid"
  }
}
```

Do not expose Rust backtraces or arbitrary server filesystem contents to the browser.

### Packed and missing values

For display and coordinate data, conversion order is fixed:

1. Read the requested values in their stored type.
2. Compare `_FillValue` and every `missing_value` in the packed domain.
3. Convert valid values to `f32`.
4. Apply `value * scale_factor + add_offset` when present.
5. Encode missing and invalid values as IEEE `NaN`.

Connectivity is not scaled and its padding value remains available from metadata. The UGRID decoder removes padding, applies `start_index`, validates every node index, and rejects malformed faces rather than wrapping an integer.

## 9. Backend implementation

### Dataset layer

`dataset.rs` owns the only NetCDF handle and implements:

- recursive group, dimension, variable, and attribute discovery;
- canonical path resolution;
- selection parsing and validation;
- hyperslab reads;
- packed-value decoding and little-endian serialization;
- connectivity reads without scalar conversion;
- response-size calculation before allocation.

Keep the NetCDF handle behind one standard mutex and serialize reads. Each Axum data handler enters `spawn_blocking`, acquires the handle, performs one hyperslab read, serializes it, and releases the handle. Do not add a worker pool until measurements show that one-file serialization is the bottleneck.

### CF/UGRID layer

`cf.rs` consumes discovered metadata and adds `view_hint` records. It must not alter raw metadata or read large data arrays during discovery. Coordinate monotonicity and connectivity validity are checked when those arrays are first requested.

The detector recognizes only the conventions required for the four view kinds. Unknown calendars, vertical-coordinate formulas, grid mappings, CRS definitions, and unrelated CF features remain visible as attributes but have no special behavior.

### HTTP layer

`server.rs` exposes the two API routes and serves embedded static files with an SPA fallback. The fixed-name application assets use `Cache-Control: no-cache` and a version query in the embedded HTML, preventing an older immutable bundle from surviving an upgrade. Version-independent font files may be cached immutably. Metadata and data responses use `Cache-Control: no-store` so browser caches do not hide a failed or changed request.

The server does not enable CORS. It accepts API requests only on its loopback listener, never opens a path supplied through HTTP, and opens the selected dataset read-only before announcing readiness.

## 10. Frontend behavior

### Dataset browser

The left panel shows the group tree, dimensions, variables, dtypes, shapes, and attributes. Selecting a variable creates:

- up to two display-dimension selectors;
- one integer slider/input for each remaining dimension;
- coordinate overrides when compatible coordinate variables exist;
- a concise warning when the current view is large or a convention hint was incomplete.

The view remains usable as `plain` index space even when the file has no CF metadata.

### Latest-request-wins controller

There is at most one scalar slice fetch in flight for a view. UI changes update `desiredSelection`. If a request is active, no intermediate HTTP request is queued. When it finishes, the result is displayed only if it still matches the desired selection; otherwise the controller immediately requests the newest desired selection.

While a dimension control is moving, choose each structured display stride independently:

```text
stride = max(1, ceil(selected_length / min(viewport_pixels, 1000)))
```

After 250 ms without a selector change, request stride one for the selected region. These are initial tuning values, kept as named constants because filesystem, network, and GPU limits vary. Animation waits for each frame read before advancing, so it cannot create a server-side backlog.

### Shared rendering rules

- Upload scalar values as a float buffer and apply a small fixed colormap in the native WebGL2 path.
- Keep missing values visibly distinct with an opaque neutral color.
- Compute an initial finite min/max in the browser; allow the user to edit and lock the range across animation frames.
- Log mode masks values at or below zero. Symlog exposes a positive linear threshold.
- Keep color transformation in the shader so range and colormap changes do not fetch data or rebuild geometry.
- Show the loaded index/range, stride, shape, dtype, units, and whether the view is preview or full resolution.

### Plain and rectilinear views

Plain variables use index coordinates. Rectilinear views read and cache the two one-dimensional coordinate arrays. Build the requested structured geometry at the current region and geometry stride, then update only the scalar texture for subsequent selector changes.

Rank-one data uses a simple SVG polyline and axes; do not add a charting library for the first curve view.

### Curvilinear view

Read X/Y coordinate arrays once for a display mapping, validate that their shape matches the displayed scalar dimensions, and build indexed triangles for each valid grid quad. Cache the geometry across scalar updates. A coordinate change, region change, or geometry-stride change invalidates that cache.

Quads with invalid coordinates are omitted. Scalar missingness is handled by the value mask and does not mutate the cached coordinate geometry.

### UGRID 2D view

On first use, read and cache node X/Y arrays plus face-node connectivity. Normalize `start_index`, remove fill padding, and validate face lengths and bounds. Triangles pass through directly; polygons are triangulated once in the browser with a small ear-clipping routine. Keep a triangle-to-source-face mapping.

- Node fields update a scalar buffer indexed by node.
- Face fields duplicate the face scalar across each generated triangle and use flat interpolation.
- The UI labels the active location as `node` or `face`.
- Meshes above `ugrid_warn_faces` require explicit confirmation and show an estimated browser-memory cost.

There is no automatic UGRID LOD in 0.1. The warning threshold is configurable, but accepting the warning loads the mesh as one object.

### Probe, curve, screenshot, and zoom

- Use the cached browser geometry for point probes. The intersection identifies a structured cell/node or a source UGRID face through the cached mapping. Add a spatial accelerator only if profiling shows the direct scan is unusable at the supported mesh threshold.
- A curve request fixes the probed spatial indices, leaves one chosen dimension as a range, indexes all others, and uses the same `/api/data` endpoint. Plot the result as SVG.
- Screenshot uses the WebGL canvas `toBlob` path and downloads a PNG containing the plot; add UI chrome or metadata export only after 0.1 if requested.
- Box zoom changes the camera immediately. For structured data it also derives an index bounding box and requests that region at the appropriate stride. For UGRID it is camera-only because the server does not partition meshes.

## 11. Delivery phases

Each phase ends in a runnable vertical slice and keeps the API contract usable by the next phase.

### Phase 0: launch skeleton

Build:

- Rust CLI with `open` and `serve`.
- Axum loopback server and embedded placeholder frontend.
- Local browser launch with printed-URL fallback.
- SSH child-process ownership, forwarding, readiness check, retry, and shutdown.
- Read-only dataset open and useful CLI errors.

Gate:

- `ncx open fixture.nc` opens a browser served by the same process.
- `ncx open ssh-alias:/path/fixture.nc` serves the remote executable through an SSH tunnel and leaves no remote process after Ctrl-C.
- A listener cannot be configured onto a non-loopback address.

### Phase 1: correct metadata and slicing

Build:

- Recursive metadata traversal and typed attributes.
- Minimal CF/UGRID hint detection.
- Selection grammar, bounds checks, byte limits, and binary headers.
- Stored-type reads, fill/missing masking, scale/offset decoding, and connectivity preservation.
- A temporary diagnostic page that lists metadata and fetches one selected slice.

Gate:

- Every fixture in the test matrix opens.
- Returned bytes, shapes, and values match the fixture expectations for full, indexed, ranged, and strided reads.
- Invalid selections fail before allocation or NetCDF access.

### Phase 2: generic and rectilinear viewer

Build:

- Group/variable browser and attribute panel.
- Display-dimension and index controls with user override.
- Plain 2D, rectilinear 2D, scalar, and rank-one curve views.
- Missing mask, colormap, range, linear/log/symlog controls.
- Latest-request-wins and structured preview/full-resolution behavior.
- Dimension animation without prefetch queues.

Gate:

- A four-dimensional packed rectilinear variable can be browsed, animated, recolored, and rescaled without reloading coordinates.
- Rapid slider movement never creates more than one in-flight scalar request from the view.
- Missing values remain transparent in every color scale.

### Phase 3: curvilinear view and interactions

Build:

- Curvilinear hint resolution and coordinate overrides.
- Cached curvilinear geometry.
- Point probe, one-dimensional curve through a point, screenshot, and box zoom.

Gate:

- A curvilinear fixture renders in coordinate space and updates only its scalar data during animation.
- A probe reports the source indices and value, and its curve matches direct fixture reads.
- Zoomed structured requests contain only the selected index region.

### Phase 4: UGRID 2D

Build:

- Topology discovery, connectivity normalization, validation, and polygon triangulation.
- Cached mesh geometry.
- Separate node-field and face-field update paths.
- Large-mesh warning and memory estimate.

Gate:

- Triangle and padded-polygon fixtures render correctly for both node and face fields.
- One-based connectivity, padding, and malformed-index cases are covered.
- Face rendering remains piecewise constant; no node interpolation is introduced.

### Phase 5: release hardening

Build:

- Friendly unsupported-dtype, malformed-convention, oversize-response, SSH, and browser-launch errors.
- Production frontend embedding and release build instructions.
- Startup/read timing on stderr for manual diagnosis.
- A clean shutdown path for local and remote sessions.

Gate:

- A release binary runs without a Node.js or Python runtime.
- The complete acceptance checklist passes locally and through SSH.
- Reference files are never modified and no server route can open a second filesystem path.

## 12. Test fixtures and checks

Keep fixtures tiny enough to inspect by hand and commit them under `tests/data`. Each fixture has deterministic expected metadata and a few known slice values.

| Fixture | Required check |
|---|---|
| NetCDF classic | Root dimensions/variables and a strided 2D read. |
| NetCDF4 groups | Nested paths, scoped same-name dimensions, and group-relative coordinate references. |
| Packed values | `_FillValue`/`missing_value` comparison before `scale_factor` and `add_offset`; missing result is `NaN`. |
| Unlimited dimension | Correct length and default last index. |
| Rectilinear | X/Y hint, coordinate cache, and scalar shape. |
| Curvilinear | Two-dimensional X/Y hint, matching shapes, invalid-coordinate quad omission. |
| UGRID node field | Topology resolution, `start_index`, padding removal, and node scalars. |
| UGRID face field | Polygon triangulation, triangle-to-face mapping, and flat face scalars. |
| Projected UGRID | Hide all topology-prefixed geometry variables; use referenced CF longitude/latitude arrays for probe readouts. |

Use focused Rust unit tests for selection parsing, byte-size overflow, packed conversion, and CF reference resolution. Use Rust integration tests for `/api/meta` and `/api/data`. Keep frontend checks focused on dimension-to-request mapping, latest-request-wins behavior, triangulation mapping, and color transforms. Add one browser smoke test only after the real UI exists; do not build a large screenshot suite around WebGL driver differences.

## 13. Initial safety and tuning limits

Use named defaults and expose only limits that operators may genuinely need to tune:

| Limit | Initial value | Behavior |
|---|---:|---|
| Maximum binary response | 1024 MiB | Reject with `413` and suggest a stride. |
| Preview extent | 1000 samples per displayed dimension, further bounded by viewport pixels | Increase stride independently per axis. |
| Selector settle delay | 250 ms | Then request stride one for the selected region. |
| UGRID warning | 2,000,000 faces | Require confirmation and show memory estimate. |

The maximum response and UGRID warning are exposed as `--max-response-bytes` and `--ugrid-warn-faces`. Preview extent and settle delay remain frontend constants until real measurements justify user-facing settings.

## 14. Acceptance checklist

Release 0.1 is complete when all of the following are true:

- [ ] Local and `host:/path` commands open the same embedded application.
- [x] The HTTP listener is loopback-only and the chosen file is the only filesystem object addressable through the API.
- [x] Classic files, NetCDF4 groups, unlimited dimensions, and the fixture dtypes are discoverable.
- [x] Full, indexed, ranged, and strided hyperslabs return the documented shape and byte order.
- [x] Fill/missing values and scale/offset decoding match expected physical values.
- [x] Plain, rectilinear, curvilinear, UGRID node, and UGRID face views render their fixtures.
- [x] Users can override detected display dimensions and coordinates.
- [x] Rapid selector movement produces strided previews without stale-request queues, followed by a full-resolution request.
- [x] Colormap, range, linear/log/symlog, missing mask, animation, point probe, curve, screenshot, and box zoom work.
- [x] Static coordinates and connectivity are reused across scalar-only updates.
- [x] Oversize reads and malformed connectivity fail safely with actionable messages.
- [ ] Closing the CLI session stops the local server or remote SSH-owned server (local verified; real SSH host pending).
- [x] The packaged application requires no Python or Node.js runtime and contains no VTK, Arrow, WebSocket, or query-planner layer.

## 15. Deferred feature path

After 0.1, add features in this order only when there is a concrete dataset that needs them:

1. Load a geometry-only shoreline `.shp` with the browser File API and render it as an overlay; keep it client-side so the HTTP API remains unchanged.
2. Generate contours from the currently loaded structured scalar slice in the browser.
3. Add vector overlays by selecting compatible U/V variables and downsampling arrows to display density.
4. Add structured-grid transects using the current coordinate mapping and data endpoint.
5. Design multi-file comparison separately, including dataset identity, coordinate alignment, and whether comparison occurs in the browser or server. Do not stretch the single-file metadata contract to cover it implicitly.

`ncview`, H5Web, and h5grove are UX and implementation references only. Reuse their proven interaction ideas where helpful; do not import their broader data models or service architectures into the 0.1 scope.
