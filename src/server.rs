use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use axum::body::Body;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

use crate::NcxResult;
use crate::dataset::{DataError, DataResponse, Dataset, DatasetMetadata};

const INDEX_HTML: &str = include_str!("../web/dist/index.html");
static VERSIONED_INDEX_HTML: LazyLock<String> = LazyLock::new(|| {
    INDEX_HTML
        .replace(
            "./assets/app.js",
            &format!("./assets/app.js?v={:016x}", content_version(APP_JAVASCRIPT)),
        )
        .replace(
            "./assets/app.css",
            &format!("./assets/app.css?v={:016x}", content_version(APP_CSS)),
        )
});
const APP_JAVASCRIPT: &[u8] = include_bytes!("../web/dist/assets/app.js");
const APP_CSS: &[u8] = include_bytes!("../web/dist/assets/app.css");
// Fonts, embedded at compile time from `res/` so the binary is the whole
// deliverable -- it has to be, since it is usually run over SSH on a cluster
// that cannot reach a CDN.
//
// Gorton Perfected is the interface face, and it is licensed for use rather
// than redistribution: serving the shipped `.otf` would hand every reader a
// complete, installable copy. What is embedded here is a subset carrying only
// the characters the viewer can set (`web/scripts/subset-fonts.py`), which is
// 307 glyphs and 17 kB against the original's full outline set. The full font
// never enters the binary and is never served.
//
// Commit Mono sets every value, and New Computer Modern Math sets every
// mathematical symbol in any face. Both are SIL OFL 1.1, so both could ship
// whole; Commit Mono is cut to the same character set as Gorton anyway. Its
// upstream `ttfautohint` TrueType source is used instead of the CFF OTF so the
// WOFF2 keeps its small-size grid-fitting tables. NewCM is already cut to a
// math-only unicode-range upstream.
//
// Commit Mono was served from jsDelivr until now, which put the one face whose
// whole job is column alignment behind the one dependency this binary cannot
// satisfy: the viewer's usual home is an SSH tunnel to a cluster with no route
// out. It was therefore missing precisely where it was needed.
//
// AVHershey draws plots; National Park backs it per glyph and sets chrome
// labels. Both are freely redistributable. Only Gorton's build source and
// subsets are gitignored; without that licence build.rs emits empty files, the
// @font-face fails, and style.css falls through to the platform sans.
const FONT_UI_REGULAR: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/gorton-400.woff2"));
const FONT_UI_SEMIBOLD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/gorton-600.woff2"));
const FONT_MONO_REGULAR: &[u8] = include_bytes!("../res/CommitMono/commit-400.woff2");
const FONT_MONO_BOLD: &[u8] = include_bytes!("../res/CommitMono/commit-700.woff2");
const FONT_MATH: &[u8] = include_bytes!("../res/NewCM/NewCMMath-Regular.woff2");
const FONT_PLOT_LIGHT: &[u8] = include_bytes!("../res/AVHershey/AVHersheySimplexLight.woff2");
const FONT_PLOT_MEDIUM: &[u8] = include_bytes!("../res/AVHershey/AVHersheySimplexMedium.woff2");
const FONT_PLOT_HEAVY: &[u8] = include_bytes!("../res/AVHershey/AVHersheySimplexHeavy.woff2");
// AVHershey is a stroke font with 89 glyphs: no smart quotes, dashes,
// ellipsis, superscripts or accents. National Park backs it per glyph so a
// `long_name` with an accent or an en-dash still sets in the plot.
const FONT_PLOT_FALLBACK: &[u8] = include_bytes!("../res/AVHershey/NationalPark.woff2");

#[derive(Clone, Copy, Serialize)]
pub struct Limits {
    pub max_response_bytes: u64,
    pub ugrid_warn_faces: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_response_bytes: 1024 * 1024 * 1024,
            ugrid_warn_faces: 2_000_000,
        }
    }
}

struct AppState {
    datasets: Vec<ServedDataset>,
    limits: Limits,
    collection: bool,
}

pub struct ServedDataset {
    pub id: String,
    pub label: String,
    pub dataset: Dataset,
}

#[derive(Serialize)]
struct MetadataResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    dataset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dataset_label: Option<String>,
    #[serde(flatten)]
    metadata: DatasetMetadata,
    limits: Limits,
}

#[derive(Serialize)]
struct DatasetSummary {
    id: String,
    label: String,
    name: String,
    variables: usize,
    dimensions: usize,
    warnings: usize,
}

#[derive(Serialize)]
struct DatasetsResponse {
    datasets: Vec<DatasetSummary>,
    collection: bool,
}

pub async fn serve<F>(
    listener: TcpListener,
    datasets: Vec<ServedDataset>,
    limits: Limits,
    collection: bool,
    shutdown: F,
) -> NcxResult<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    if datasets.is_empty() {
        return Err("ncx serve needs at least one dataset".to_owned());
    }
    let mut ids = HashSet::with_capacity(datasets.len());
    if datasets.iter().any(|dataset| !ids.insert(&dataset.id)) {
        return Err("ncx serve dataset IDs must be unique".to_owned());
    }
    let state = Arc::new(AppState {
        datasets,
        limits,
        collection,
    });
    let api = Router::new()
        .route("/datasets", get(dataset_list))
        .route("/meta", get(metadata))
        .route("/data", get(data))
        .fallback(api_not_found);
    let app = Router::new()
        .route("/", get(index))
        .nest("/api", api)
        .route("/assets/app.js", get(app_javascript))
        .route("/assets/app.css", get(app_css))
        .route("/fonts/gorton-400.woff2", get(font_ui_regular))
        .route("/fonts/gorton-600.woff2", get(font_ui_semibold))
        .route("/fonts/commit-400.woff2", get(font_mono_regular))
        .route("/fonts/commit-700.woff2", get(font_mono_bold))
        .route("/fonts/cmmath.woff2", get(font_math))
        .route("/fonts/hershey-light.woff2", get(font_plot_light))
        .route("/fonts/hershey-medium.woff2", get(font_plot_medium))
        .route("/fonts/hershey-heavy.woff2", get(font_plot_heavy))
        .route("/fonts/nationalpark.woff2", get(font_plot_fallback))
        .fallback(index)
        .with_state(state);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .map_err(|error| format!("HTTP server failed: {error}"))
}

async fn index() -> Response {
    (
        [
            (
                CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        ],
        VERSIONED_INDEX_HTML.as_str(),
    )
        .into_response()
}

async fn dataset_list(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let datasets = state
        .datasets
        .iter()
        .map(|source| {
            let metadata = source.dataset.metadata();
            DatasetSummary {
                id: source.id.clone(),
                label: source.label.clone(),
                name: metadata.dataset.name.clone(),
                variables: metadata.variables.len(),
                dimensions: metadata.dimensions.len(),
                warnings: metadata.warnings.len(),
            }
        })
        .collect();
    (
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(DatasetsResponse {
            datasets,
            collection: state.collection,
        }),
    )
}

#[derive(Default, Deserialize)]
struct DatasetQuery {
    dataset: Option<String>,
}

async fn metadata(
    State(state): State<Arc<AppState>>,
    query: Result<Query<DatasetQuery>, QueryRejection>,
) -> Response {
    let Query(query) = match query {
        Ok(query) => query,
        Err(error) => return invalid_query(error),
    };
    let source = match state.select(query.dataset.as_deref()) {
        Ok(source) => source,
        Err(error) => return error_response(error),
    };
    (
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(state.metadata_response(source)),
    )
        .into_response()
}

#[derive(Deserialize)]
struct DataQuery {
    dataset: Option<String>,
    path: String,
    selection: String,
    stride: String,
}

async fn data(
    State(state): State<Arc<AppState>>,
    query: Result<Query<DataQuery>, QueryRejection>,
) -> Response {
    let Query(query) = match query {
        Ok(query) => query,
        Err(error) => return invalid_query(error),
    };
    let maximum = state.limits.max_response_bytes;
    let read = tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let result = state.select(query.dataset.as_deref())?.dataset.read_data(
            &query.path,
            &query.selection,
            &query.stride,
            maximum,
        );
        if started.elapsed().as_millis() >= 100 {
            eprintln!(
                "ncx: read {} in {} ms",
                query.path,
                started.elapsed().as_millis()
            );
        }
        result
    })
    .await;

    match read {
        Ok(Ok(data)) => data_response(data),
        Ok(Err(error)) => error_response(error),
        Err(error) => error_response(DataError {
            status: 500,
            code: "read_task_failed",
            message: error.to_string(),
            suggested_stride: None,
        }),
    }
}

impl AppState {
    fn metadata_response(&self, source: &ServedDataset) -> MetadataResponse {
        let named = self.datasets.len() > 1;
        MetadataResponse {
            dataset_id: named.then(|| source.id.clone()),
            dataset_label: named.then(|| source.label.clone()),
            metadata: source.dataset.metadata().clone(),
            limits: self.limits,
        }
    }

    fn select(&self, requested: Option<&str>) -> Result<&ServedDataset, DataError> {
        if let Some(id) = requested {
            return self
                .datasets
                .iter()
                .find(|dataset| dataset.id == id)
                .ok_or_else(|| DataError {
                    status: 404,
                    code: "dataset_not_found",
                    message: format!("unknown dataset {id:?}"),
                    suggested_stride: None,
                });
        }
        if self.datasets.len() == 1 {
            return Ok(&self.datasets[0]);
        }
        Err(DataError {
            status: 400,
            code: "dataset_required",
            message: "dataset is required when more than one dataset is loaded".to_owned(),
            suggested_stride: None,
        })
    }
}

fn invalid_query(error: QueryRejection) -> Response {
    error_response(DataError {
        status: 400,
        code: "invalid_query",
        message: error.body_text(),
        suggested_stride: None,
    })
}

fn data_response(data: DataResponse) -> Response {
    let shape = data
        .shape
        .iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut response = Response::new(Body::from(data.body));
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        HeaderName::from_static("x-ncx-dtype"),
        HeaderValue::from_static(data.dtype),
    );
    headers.insert(
        HeaderName::from_static("x-ncx-shape"),
        HeaderValue::from_str(&shape).expect("numeric shape is a valid HTTP header"),
    );
    headers.insert(
        HeaderName::from_static("x-ncx-endian"),
        HeaderValue::from_static("little"),
    );
    response
}

#[derive(Serialize)]
struct ApiError {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    suggested_stride: Option<Vec<usize>>,
}

fn error_response(error: DataError) -> Response {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(ApiError {
            error: ErrorDetail {
                code: error.code,
                message: error.message,
                suggested_stride: error.suggested_stride,
            },
        }),
    )
        .into_response()
}

async fn api_not_found() -> Response {
    error_response(DataError {
        status: 404,
        code: "api_route_not_found",
        message: "unknown ncx API route".to_owned(),
        suggested_stride: None,
    })
}

fn font(bytes: &'static [u8]) -> Response {
    static_asset("font/woff2", bytes)
}

fn static_asset(content_type: &'static str, bytes: &'static [u8]) -> Response {
    (
        [
            (CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
        ],
        bytes,
    )
        .into_response()
}

const fn content_version(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325;
    let mut index = 0;
    while index < bytes.len() {
        hash ^= bytes[index] as u64;
        hash = hash.wrapping_mul(0x100000001b3);
        index += 1;
    }
    hash
}

async fn app_javascript() -> Response {
    static_asset("text/javascript; charset=utf-8", APP_JAVASCRIPT)
}

async fn app_css() -> Response {
    static_asset("text/css; charset=utf-8", APP_CSS)
}

async fn font_ui_regular() -> Response {
    font(FONT_UI_REGULAR)
}

async fn font_ui_semibold() -> Response {
    font(FONT_UI_SEMIBOLD)
}

async fn font_mono_regular() -> Response {
    font(FONT_MONO_REGULAR)
}

async fn font_mono_bold() -> Response {
    font(FONT_MONO_BOLD)
}

async fn font_math() -> Response {
    font(FONT_MATH)
}

async fn font_plot_light() -> Response {
    font(FONT_PLOT_LIGHT)
}

async fn font_plot_medium() -> Response {
    font(FONT_PLOT_MEDIUM)
}

async fn font_plot_heavy() -> Response {
    font(FONT_PLOT_HEAVY)
}

async fn font_plot_fallback() -> Response {
    font(FONT_PLOT_FALLBACK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_assets_are_content_versioned_and_immutable() {
        assert!(
            VERSIONED_INDEX_HTML.contains(&format!(
                "./assets/app.js?v={:016x}",
                content_version(APP_JAVASCRIPT)
            )),
            "the HTML must bypass immutable bundles from older ncx releases"
        );

        let response = static_asset("text/plain", b"test");
        assert_eq!(
            response.headers()[CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
    }

    #[test]
    fn dataset_selection_preserves_single_file_and_bounds_multi_file_requests() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/classic.nc");
        let source = |id: &str| ServedDataset {
            id: id.to_owned(),
            label: id.to_owned(),
            dataset: Dataset::open(&path).unwrap(),
        };
        let single = AppState {
            datasets: vec![source("only")],
            limits: Limits::default(),
            collection: false,
        };
        assert_eq!(single.select(None).unwrap().id, "only");
        let metadata = single.metadata_response(single.select(None).unwrap());
        assert_eq!(metadata.dataset_id, None);
        assert_eq!(metadata.dataset_label, None);

        let multiple = AppState {
            datasets: vec![source("case-a"), source("case-b")],
            limits: Limits::default(),
            collection: false,
        };
        assert_eq!(
            multiple.select(None).err().unwrap().code,
            "dataset_required"
        );
        assert_eq!(multiple.select(Some("case-b")).unwrap().id, "case-b");
        let metadata = multiple.metadata_response(multiple.select(Some("case-b")).unwrap());
        assert_eq!(metadata.dataset_id.as_deref(), Some("case-b"));
        assert_eq!(
            multiple.select(Some("missing")).err().unwrap().code,
            "dataset_not_found"
        );
    }
}
