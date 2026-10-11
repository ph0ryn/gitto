use axum::{
    Json, Router,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};

use crate::git;

#[derive(Clone)]
pub struct AppState {
    pub repository: Arc<PathBuf>,
}

impl IntoResponse for git::Error {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::Invalid(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Unsupported(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::NoWorktree => StatusCode::CONFLICT,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::Git(error) => match error.code() {
                git2::ErrorCode::NotFound | git2::ErrorCode::UnbornBranch => StatusCode::NOT_FOUND,
                git2::ErrorCode::InvalidSpec | git2::ErrorCode::Ambiguous => {
                    StatusCode::BAD_REQUEST
                }
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
            Self::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
                StatusCode::NOT_FOUND
            }
            Self::Io(_) | Self::Task(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        #[derive(Serialize)]
        struct ErrorBody {
            error: String,
        }
        (
            status,
            Json(ErrorBody {
                error: self.to_string(),
            }),
        )
            .into_response()
    }
}

#[derive(Deserialize)]
pub struct RevisionQuery {
    #[serde(default = "head")]
    pub revision: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Deserialize)]
pub struct CommitsQuery {
    #[serde(default = "head")]
    pub revision: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_size")]
    pub limit: usize,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FileSource {
    Commit,
    Index,
    Worktree,
}

#[derive(Deserialize)]
pub struct FileQuery {
    #[serde(default = "commit_source")]
    pub source: FileSource,
    #[serde(default = "head")]
    pub revision: String,
    pub path: String,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiffSource {
    Staged,
    Unstaged,
    Untracked,
    Commit,
}

#[derive(Deserialize)]
pub struct DiffQuery {
    pub source: DiffSource,
    #[serde(default = "head")]
    pub revision: String,
    pub path: Option<String>,
}

fn head() -> String {
    "HEAD".into()
}

fn page_size() -> usize {
    50
}

fn commit_source() -> FileSource {
    FileSource::Commit
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/repo", get(repo))
        .route("/commits", get(commits))
        .route("/tree", get(tree))
        .route("/file", get(file))
        .route("/status", get(status))
        .route("/diff", get(diff))
        .method_not_allowed_fallback(|| async { git::Error::MethodNotAllowed })
        .fallback(|| async { git::Error::NotFound("Unknown API route".into()) })
}

async fn read<T: Send + 'static>(
    state: AppState,
    action: impl FnOnce(git2::Repository) -> Result<T, git::Error> + Send + 'static,
) -> Result<Json<T>, git::Error> {
    // libgit2 is blocking and Repository is not Sync; open a fresh handle per request.
    tokio::task::spawn_blocking(move || action(git2::Repository::open(&*state.repository)?))
        .await?
        .map(Json)
}

async fn repo(State(state): State<AppState>) -> Result<Json<git::RepoInfo>, git::Error> {
    read(state, |repo| git::info(&repo)).await
}

async fn commits(
    State(state): State<AppState>,
    query: Result<Query<CommitsQuery>, QueryRejection>,
) -> Result<Json<git::History>, git::Error> {
    let Query(query) = query.map_err(|error| git::Error::Invalid(error.body_text()))?;
    read(state, move |repo| git::commits(&repo, query)).await
}

async fn tree(
    State(state): State<AppState>,
    query: Result<Query<RevisionQuery>, QueryRejection>,
) -> Result<Json<git::TreeListing>, git::Error> {
    let Query(query) = query.map_err(|error| git::Error::Invalid(error.body_text()))?;
    read(state, move |repo| git::tree(&repo, query)).await
}

async fn file(
    State(state): State<AppState>,
    query: Result<Query<FileQuery>, QueryRejection>,
) -> Result<Json<git::FileContent>, git::Error> {
    let Query(query) = query.map_err(|error| git::Error::Invalid(error.body_text()))?;
    read(state, move |repo| git::file(&repo, query)).await
}

async fn status(State(state): State<AppState>) -> Result<Json<git::WorkingStatus>, git::Error> {
    read(state, |repo| git::status(&repo)).await
}

async fn diff(
    State(state): State<AppState>,
    query: Result<Query<DiffQuery>, QueryRejection>,
) -> Result<Json<git::DiffResult>, git::Error> {
    let Query(query) = query.map_err(|error| git::Error::Invalid(error.body_text()))?;
    read(state, move |repo| git::diff(&repo, query)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, header},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn malformed_query_is_rejected_as_json_before_opening_a_repository() {
        let state = AppState {
            repository: Arc::new(PathBuf::from("/no-repository")),
        };
        let app = routes().with_state(state);
        for uri in [
            "/file?source=invalid&path=a",
            "/file",
            "/commits?limit=invalid",
            "/diff?source=invalid",
        ] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        }
    }

    #[test]
    fn errors_have_explicit_http_status() {
        assert_eq!(
            git::Error::Invalid("path".into()).into_response().status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            git::Error::NotFound("file".into()).into_response().status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            git::Error::NoWorktree.into_response().status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            git::Error::Unsupported("encoding".into())
                .into_response()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}
