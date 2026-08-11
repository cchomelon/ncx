ncx: Remote ncview
1. What is inside this NetCDF?
2. How does the slice of this variable looks like?
3. Along dimensions, how does it change?

Browser -> HTTP through SSH tunnel -> ncx agent, single Rust process -> NetCDF C -> run.nc

Client run
```bash
ncx open host:/data/run.nc
```
CLI do ```ncx serve```, establish SSH port forwarding, opening browser.

Agent only bind ```127.0.0.1```.

SSH does not need HTTPS, authentication, user database, path ACL, gateway or persistent daemon.

One session, one process. Session ends, process ends.

## Stack
Front end: Typescript, React, Three.js / react-three-fiber, WebGL2
Backend: Rust, Axum, Tokio, Serde, georust/netcdf

Frontend build is embedded inside Rust executable.

Two runtime ONLY: browser, ncx process

No python, xarray, dask, VTK, PyVista

## Data

No need for complete canonical scientific data model. NetCDF is the source of truth.
Thin UI metadata:

```
Dimension
    name
    length
    unlimited

Variable
    path
    dtype
    dimensions
    attributes
    view_hint:
        Plain
        Rectilinear
        Curvilinear
        UGrid2D
```

All dimensions are first just dimension. UI let user picks two dimension as display X, Y. Others are index sliders.
e.g.

```
temperature(time, level, y, x)

display:
    y * x

selectors:
    time = 120
    level = 4
```

CF detection is only for reasonable defaults. User can always override.

## CF and UGRID

Rectilinear:

```
temperature(y, x)
lon(x)
lat(y)
```

Curvilinear:

```
temperature(y, x)
lon(y, x)
lat(y, x)
```

UGRID:

```
mesh_topology
node coordinates
face_node_connectivity
location = node | face
```

No UnstructuredGrid1D/2D/3D complete hierarchy.

No CRS transformation.

No full CF conformance engine.

Scale factor, offset, fill value, missing value are data correctness that must be handled.

## HTTP API

Two endpoint:

```
GET /api/meta

GET /api/data?path=/temperature&selection=120,4,:,:&stride=1,1,2,2
```

/api/meta returns JSON. /api/data returns binary typed array.

Header only need ```dtype, shape, endianness```

Scalar display data can be decoded as Float32. Connectivity stays UInt32/Int32.

No need for:

```
Protobuf
WebSocket Protocol
Arrow
Arrow Flight
request planner
representation graph
```

## Rendering

Rectilinear grid:

Coordinates are read once. GPU texture directly uses scalar slice.

Curvilinear grid:

```x(i,j), y(i,j)``` are read once for geometry build, then update scalar only.

UGRID:

node coordinates and connectivity are read once.
Node field updates vertex scalar.
Face field are face centered, do not interpolate in silence.
Polygon triangulation are built once at client.
So the timeframe steady state is basically just: read one hyperslab -> send Float32 buffer -> GPU upload

## Progressive loading

No need for generic LOD planner.

When sliding time slider with structured grid, demand stride according to display size: 4000 x 4000 -> 1000 x 1000 preview

Full resolution is requested only after the user stops sliding.

One slice request per client. e.g. If the user slides quickly from timestep 10 -> 30, 11 -> 29 is not worthy for queuing.

Static geometry, coordinates, connectivity are all kept in browser memory.

UGRID v1 does not do auto LOD. Warn when mesh over configurable limit, but not doing mesh partition service.

## Functionalities

Core: Dataset, group, curvilinear, UGRID node/face rendering; Time or other dimension animation; colormap, range, linear, log, symlog; missing value mask; point probe;

Dimension 1D curve upon clicking a location;

Screenshot;

Local zoom-in/out by dragging box on map.

Shoreline (.shp) loading.

Contour, vector overlay, transect, multi-file comparison.

## Infra

Conservative, simple, minimalistic, maintainable like ncview.

```
ncx/
    src/
        main.rs
        cli.rs
        server.rs
        dataset.rs
        cf.rs
    web/
        src/
    test/
        data/
```

Test fixture focus on
NetCDF classic, NetCDF4 groups, scale/offset/fill, unlimited dimension, rectilinear, curvilinear, UGRID node field, UGRID face field.

No docker.

No VTK.js, no python worker, no query planner.

Reference repos:
ncview
H5Web
h5grove

