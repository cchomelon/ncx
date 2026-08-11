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
    let version = env!("CARGO_PKG_VERSION");
    INDEX_HTML
        .replace("/assets/app.js", &format!("/assets/app.js?v={version}"))
        .replace("/assets/app.css", &format!("/assets/app.css?v={version}"))
});
const APP_JAVASCRIPT: &[u8] = include_bytes!("../web/dist/assets/app.js");
const APP_CSS: &[u8] = include_bytes!("../web/dist/assets/app.css");
const FONT_LIGHT: &[u8] =
    include_bytes!("../../Style/Fonts/AVHershey-OTF/otf/AVHersheySimplexLight.otf");
const FONT_MEDIUM: &[u8] =
    include_bytes!("../../Style/Fonts/AVHershey-OTF/otf/AVHersheySimplexMedium.otf");
const FONT_HEAVY: &[u8] =
    include_bytes!("../../Style/Fonts/AVHershey-OTF/otf/AVHersheySimplexHeavy.otf");

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
    dataset: Dataset,
    limits: Limits,
}

#[derive(Serialize)]
struct MetadataResponse {
    #[serde(flatten)]
    metadata: DatasetMetadata,
    limits: Limits,
}

pub async fn serve<F>(
    listener: TcpListener,
    dataset: Dataset,
    limits: Limits,
    shutdown: F,
) -> NcxResult<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let state = Arc::new(AppState { dataset, limits });
    let api = Router::new()
        .route("/meta", get(metadata))
        .route("/data", get(data))
        .fallback(api_not_found);
    let app = Router::new()
        .route("/", get(index))
        .nest("/api", api)
        .route("/assets/app.js", get(app_javascript))
        .route("/assets/app.css", get(app_css))
        .route(
            "/Style/Fonts/AVHershey-OTF/otf/AVHersheySimplexLight.otf",
            get(font_light),
        )
        .route(
            "/Style/Fonts/AVHershey-OTF/otf/AVHersheySimplexMedium.otf",
            get(font_medium),
        )
        .route(
            "/Style/Fonts/AVHershey-OTF/otf/AVHersheySimplexHeavy.otf",
            get(font_heavy),
        )
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

async fn metadata(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(MetadataResponse {
            metadata: state.dataset.metadata().clone(),
            limits: state.limits,
        }),
    )
}

#[derive(Deserialize)]
struct DataQuery {
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
        Err(error) => {
            return error_response(DataError {
                status: 400,
                code: "invalid_query",
                message: error.body_text(),
                suggested_stride: None,
            });
        }
    };
    let maximum = state.limits.max_response_bytes;
    let read = tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let result = state
            .dataset
            .read_data(&query.path, &query.selection, &query.stride, maximum);
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
    static_asset("font/otf", bytes)
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

fn application_asset(content_type: &'static str, bytes: &'static [u8]) -> Response {
    (
        [
            (CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        ],
        bytes,
    )
        .into_response()
}

async fn app_javascript() -> Response {
    application_asset("text/javascript; charset=utf-8", APP_JAVASCRIPT)
}

async fn app_css() -> Response {
    application_asset("text/css; charset=utf-8", APP_CSS)
}

async fn font_light() -> Response {
    font(FONT_LIGHT)
}

async fn font_medium() -> Response {
    font(FONT_MEDIUM)
}

async fn font_heavy() -> Response {
    font(FONT_HEAVY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_assets_are_versioned_and_revalidated() {
        let version = env!("CARGO_PKG_VERSION");
        assert!(
            VERSIONED_INDEX_HTML.contains(&format!("/assets/app.js?v={version}")),
            "the HTML must bypass immutable bundles from older ncx releases"
        );

        let response = application_asset("text/plain", b"test");
        assert_eq!(response.headers()[CACHE_CONTROL], "no-cache");
    }
}
