use axum::{
    Json, Router,
    extract::{Path, Request, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::Deserialize;
use std::{
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::Notify};
use tower::ServiceExt;

use crate::{
    api::{self, AppState},
    assets,
    cli::Cli,
    daemon, git,
    registry::{self, Registration, Registry},
};

struct Sessions {
    registry: Registry,
    stopping: bool,
}

#[derive(Clone)]
struct ServerState {
    sessions: Arc<Mutex<Sessions>>,
    token: Arc<str>,
    changed: Arc<Notify>,
}

impl ServerState {
    fn new(registry: Registry, token: String) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(Sessions {
                registry,
                stopping: false,
            })),
            token: token.into(),
            changed: Arc::new(Notify::new()),
        }
    }

    fn sessions(&self) -> Result<MutexGuard<'_, Sessions>, Failure> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| Failure::internal("Repository registry lock failed"))?;
        if sessions.stopping {
            return Err(Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "The gitto server is stopping; try again".into(),
            ));
        }
        Ok(sessions)
    }
}

#[derive(Debug)]
struct Failure(StatusCode, String);

impl Failure {
    fn internal(message: impl Into<String>) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, message.into())
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

impl From<registry::Error> for Failure {
    fn from(error: registry::Error) -> Self {
        let status = match error {
            registry::Error::NotFound => StatusCode::NOT_FOUND,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(status, error.to_string())
    }
}

/// Identity is the canonical worktree root (or bare root), never the shared Git directory.
pub fn repository_path(path: &FsPath) -> Result<PathBuf, git::Error> {
    let repository = git2::Repository::discover(path)?;
    Ok(repository
        .workdir()
        .unwrap_or(repository.path())
        .canonicalize()?)
}

pub async fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let files = daemon::server_files(cli.port)?;
    let _guard = daemon::cache_lock(&files)?.ok_or("A gitto server already owns this cache")?;
    let registry = Registry::load(files.registry.clone(), Instant::now())?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, cli.port)).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AddrInUse {
            std::io::Error::new(error.kind(), format!("Port {} is already in use. Use --port <port> to choose another fixed port.", cli.port))
        } else {
            error
        }
    })?;
    let host = listener.local_addr()?.to_string();
    let token = daemon::server_token(&files, cli.port)?;
    let state = ServerState::new(registry, token);
    let app = application(state.clone(), host);
    let (stopped, signal) = tokio::sync::oneshot::channel();
    let serving = axum::serve(listener, app).with_graceful_shutdown(async move {
        shutdown(state).await;
        let _ = stopped.send(());
    });
    finish_server(
        std::future::IntoFuture::into_future(serving),
        async {
            let _ = signal.await;
        },
        Duration::from_secs(5),
    )
    .await?;
    Ok(())
}

async fn finish_server(
    serving: impl std::future::Future<Output = std::io::Result<()>>,
    stopped: impl std::future::Future<Output = ()>,
    timeout: Duration,
) -> std::io::Result<()> {
    tokio::pin!(serving);
    tokio::select! {
        result = &mut serving => result,
        _ = stopped => match tokio::time::timeout(timeout, serving).await {
            Ok(result) => result,
            Err(_) => {
                eprintln!("gitto: stopped waiting for unfinished HTTP requests during shutdown");
                Ok(())
            }
        }
    }
}

fn application(state: ServerState, host: String) -> Router {
    let control = Router::new()
        .route("/health", get(health))
        .route("/repos", get(registrations).post(register))
        .fallback(|| async { Failure(StatusCode::NOT_FOUND, "Unknown control route".into()) })
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize));
    let repository_api = Router::new()
        .route("/heartbeat", post(heartbeat))
        .route("/close", post(close))
        .fallback(read_repository);
    Router::new()
        .nest("/_gitto", control)
        .nest("/r/{id}/api", repository_api)
        .route("/r/{id}", get(repository_redirect))
        .route("/r/{id}/", get(repository_page))
        .route(
            "/",
            get(|| async { "Open a repository with gitto <path>." }),
        )
        .fallback(assets::serve)
        .with_state(state)
        .layer(middleware::from_fn_with_state(host, protect))
}

async fn authorize(State(state): State<ServerState>, request: Request, next: Next) -> Response {
    let expected = format!("Bearer {}", state.token);
    if request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(expected.as_str())
    {
        return Failure(
            StatusCode::UNAUTHORIZED,
            "Local CLI authorization required".into(),
        )
        .into_response();
    }
    next.run(request).await
}

async fn health(State(state): State<ServerState>) -> Result<Json<serde_json::Value>, Failure> {
    drop(state.sessions()?);
    Ok(Json(
        serde_json::json!({ "protocol": 1, "version": env!("CARGO_PKG_VERSION") }),
    ))
}

async fn registrations(
    State(state): State<ServerState>,
) -> Result<Json<Vec<Registration>>, Failure> {
    Ok(Json(state.sessions()?.registry.list(Instant::now())))
}

#[derive(Deserialize)]
struct Register {
    path: PathBuf,
}

async fn register(
    State(state): State<ServerState>,
    input: Result<Json<Register>, JsonRejection>,
) -> Response {
    let Json(input) = match input {
        Ok(input) => input,
        Err(error) => return Failure(StatusCode::BAD_REQUEST, error.body_text()).into_response(),
    };
    if !input.path.is_absolute() {
        return Failure(
            StatusCode::BAD_REQUEST,
            "Repository path must be absolute".into(),
        )
        .into_response();
    }
    let path = match tokio::task::spawn_blocking(move || repository_path(&input.path)).await {
        Ok(Ok(path)) => path,
        Ok(Err(error)) => return error.into_response(),
        Err(error) => return Failure::internal(error.to_string()).into_response(),
    };
    let result = state.sessions().and_then(|mut sessions| {
        sessions
            .registry
            .register(path, Instant::now())
            .map_err(Failure::from)
    });
    match result {
        Ok(registration) => {
            state.changed.notify_one();
            Json(registration).into_response()
        }
        Err(error) => error.into_response(),
    }
}

fn browser_request(headers: &HeaderMap) -> Result<(), Failure> {
    if headers
        .get("X-Gitto-Request")
        .and_then(|value| value.to_str().ok())
        != Some("1")
        || headers
            .get("Sec-Fetch-Site")
            .is_some_and(|value| value != "same-origin")
    {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "A same-origin gitto request is required".into(),
        ));
    }
    Ok(())
}

async fn heartbeat(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Failure> {
    browser_request(&headers)?;
    state.sessions()?.registry.heartbeat(&id, Instant::now())?;
    state.changed.notify_one();
    Ok(Json(serde_json::json!({})))
}

async fn close(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Failure> {
    browser_request(&headers)?;
    state.sessions()?.registry.close(&id)?;
    state.changed.notify_one();
    Ok(Json(serde_json::json!({})))
}

async fn read_repository(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let path = match state
        .sessions()
        .and_then(|sessions| sessions.registry.repository(&id).map_err(Failure::from))
    {
        Ok(path) => path,
        Err(error) => return error.into_response(),
    };
    // Nesting strips /r/<id>/api; each request receives its own immutable repository state.
    let app = api::routes().with_state(AppState {
        repository: Arc::new(path),
    });
    match app.oneshot(request).await {
        Ok(response) => response,
        Err(error) => match error {},
    }
}

async fn repository_page(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<Response, Failure> {
    state.sessions()?.registry.repository(&id)?;
    Ok(assets::serve(Uri::from_static("/")).await)
}

async fn repository_redirect(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Redirect, Failure> {
    state.sessions()?.registry.repository(&id)?;
    let query = uri
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    Ok(Redirect::permanent(&format!("/r/{id}/{query}")))
}

async fn shutdown(state: ServerState) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let interrupt = tokio::signal::ctrl_c();
    tokio::pin!(interrupt);
    loop {
        tokio::select! {
            _ = tick.tick() => {},
            _ = state.changed.notified() => {},
            result = &mut interrupt => {
                if let Err(error) = result {
                    eprintln!("gitto: could not receive Ctrl+C: {error}");
                }
                if let Ok(mut sessions) = state.sessions.lock() {
                    sessions.stopping = true;
                }
                return;
            }
        }
        // Commit shutdown under the same lock used by registrations and heartbeats.
        let mut sessions = match state.sessions.lock() {
            Ok(sessions) => sessions,
            Err(error) => {
                eprintln!("gitto: repository registry lock failed: {error}");
                return;
            }
        };
        if sessions.registry.should_shutdown(Instant::now()) {
            sessions.stopping = true;
            return;
        }
    }
}

fn valid_host(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        == Some(expected)
}

async fn protect(State(host): State<String>, request: Request, next: Next) -> Response {
    // Reject DNS rebinding: only the loopback URL we printed may access this server.
    let mut response = if !valid_host(request.headers(), &host) {
        Failure(StatusCode::FORBIDDEN, "Invalid Host".into()).into_response()
    } else if request
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|origin| origin.to_str().ok() != Some(format!("http://{host}").as_str()))
    {
        Failure(StatusCode::FORBIDDEN, "Invalid Origin".into()).into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::get};
    use tower::ServiceExt;

    #[tokio::test]
    async fn shutdown_bounds_unfinished_requests_but_not_normal_server_lifetime() {
        let drained = tokio::time::timeout(
            Duration::from_millis(100),
            finish_server(std::future::pending(), async {}, Duration::ZERO),
        )
        .await;
        assert!(
            drained.is_ok(),
            "unfinished HTTP requests must not hold the process lock forever"
        );
        assert!(drained.unwrap().is_ok());
        let still_running = tokio::time::timeout(
            Duration::from_millis(10),
            finish_server(
                std::future::pending(),
                std::future::pending(),
                Duration::ZERO,
            ),
        )
        .await;
        assert!(
            still_running.is_err(),
            "drain timeout must not limit a live server"
        );
    }

    #[tokio::test]
    async fn server_errors_are_not_hidden_by_shutdown_handling() {
        let result = finish_server(
            async { Err(std::io::Error::other("serve failed")) },
            std::future::pending(),
            Duration::ZERO,
        )
        .await;
        assert_eq!(result.unwrap_err().to_string(), "serve failed");
    }

    struct TestApp {
        directory: PathBuf,
        state: ServerState,
        app: Router,
        ids: [String; 2],
    }

    impl TestApp {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let directory = std::env::temp_dir().join(format!(
                "gitto-server-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&directory).unwrap();
            let now = Instant::now();
            let mut registry = Registry::load(directory.join("registry.json"), now).unwrap();
            let first = registry.register(directory.join("one"), now).unwrap();
            let second = registry.register(directory.join("two"), now).unwrap();
            let state = ServerState::new(registry, "test-secret".into());
            let app = application(state.clone(), "127.0.0.1:47319".into());
            Self {
                directory,
                state,
                app,
                ids: [first.id, second.id],
            }
        }

        async fn request(
            &self,
            method: &str,
            uri: &str,
            headers: &[(&str, &str)],
            body: &str,
        ) -> Response {
            let mut request = Request::builder()
                .method(method)
                .uri(uri)
                .header(header::HOST, "127.0.0.1:47319");
            for (key, value) in headers {
                request = request.header(*key, *value);
            }
            self.app
                .clone()
                .oneshot(request.body(Body::from(body.to_owned())).unwrap())
                .await
                .unwrap()
        }
    }

    impl Drop for TestApp {
        fn drop(&mut self) {
            assert_eq!(
                self.directory.parent(),
                Some(std::env::temp_dir().as_path())
            );
            assert!(
                self.directory
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("gitto-server-")
            );
            std::fs::remove_dir_all(&self.directory).unwrap();
        }
    }

    async fn json(response: Response) -> serde_json::Value {
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn control_routes_require_the_private_cli_token() {
        let fixture = TestApp::new();
        for uri in ["/_gitto/health", "/_gitto/repos"] {
            for headers in [
                vec![],
                vec![("X-Gitto-Request", "1")],
                vec![("Authorization", "Bearer wrong")],
            ] {
                assert_eq!(
                    fixture.request("GET", uri, &headers, "").await.status(),
                    StatusCode::UNAUTHORIZED
                );
            }
        }
        let health = fixture
            .request(
                "GET",
                "/_gitto/health",
                &[("Authorization", "Bearer test-secret")],
                "",
            )
            .await;
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(json(health).await["protocol"], 1);
        let response = fixture
            .request(
                "GET",
                "/_gitto/repos",
                &[("Authorization", "Bearer test-secret")],
                "",
            )
            .await;
        let entries = json(response).await;
        assert_eq!(entries.as_array().unwrap().len(), 2);
        assert_eq!(entries[0]["id"], fixture.ids[0]);
        assert_eq!(entries[1]["id"], fixture.ids[1]);
        assert_eq!(
            fixture
                .request(
                    "POST",
                    "/_gitto/repos",
                    &[("Content-Type", "application/json")],
                    r#"{"path":"/tmp"}"#
                )
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn registration_rejects_malformed_and_relative_paths_as_json() {
        let fixture = TestApp::new();
        for body in [r#"{"path":"relative"}"#, "{}", "invalid"] {
            let response = fixture
                .request(
                    "POST",
                    "/_gitto/repos",
                    &[
                        ("Authorization", "Bearer test-secret"),
                        ("Content-Type", "application/json"),
                    ],
                    body,
                )
                .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert!(json(response).await["error"].is_string());
        }
    }

    #[tokio::test]
    async fn git_apis_are_scoped_to_a_registered_repository() {
        let fixture = TestApp::new();
        for id in &fixture.ids {
            let uri = format!("/r/{id}/api/file?source=invalid&path=a");
            let response = fixture.request("GET", &uri, &[], "").await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert!(json(response).await["error"].is_string());
        }
        for uri in [
            "/r/unknown/api/file?source=invalid&path=a",
            "/api/repo",
            "/r/unknown/",
        ] {
            assert_eq!(
                fixture.request("GET", uri, &[], "").await.status(),
                StatusCode::NOT_FOUND
            );
        }
        let missing = fixture
            .request("GET", &format!("/r/{}/api/repo", fixture.ids[0]), &[], "")
            .await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert!(json(missing).await["error"].is_string());
    }

    #[tokio::test]
    async fn browser_mutations_require_non_simple_same_origin_requests() {
        let fixture = TestApp::new();
        let uri = format!("/r/{}/api/heartbeat", fixture.ids[0]);
        for headers in [
            vec![],
            vec![("X-Gitto-Request", "0")],
            vec![("X-Gitto-Request", "1"), ("Sec-Fetch-Site", "cross-site")],
            vec![("X-Gitto-Request", "1"), ("Origin", "http://evil.example")],
        ] {
            assert_eq!(
                fixture.request("POST", &uri, &headers, "").await.status(),
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            fixture
                .request(
                    "POST",
                    &uri,
                    &[
                        ("X-Gitto-Request", "1"),
                        ("Origin", "http://127.0.0.1:47319"),
                        ("Sec-Fetch-Site", "same-origin")
                    ],
                    ""
                )
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            fixture.request("GET", &uri, &[], "").await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn explicit_close_removes_one_repository_for_every_tab() {
        let fixture = TestApp::new();
        let [first, second] = &fixture.ids;
        let close_uri = format!("/r/{first}/api/close");
        assert_eq!(
            fixture.request("POST", &close_uri, &[], "").await.status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            fixture
                .request("POST", &close_uri, &[("X-Gitto-Request", "1")], "")
                .await
                .status(),
            StatusCode::OK
        );
        for uri in [format!("/r/{first}/api/heartbeat"), close_uri] {
            assert_eq!(
                fixture
                    .request("POST", &uri, &[("X-Gitto-Request", "1")], "")
                    .await
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            fixture
                .request("GET", &format!("/r/{first}/api/repo"), &[], "")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            fixture
                .request(
                    "POST",
                    &format!("/r/{second}/api/heartbeat"),
                    &[("X-Gitto-Request", "1")],
                    ""
                )
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            fixture
                .state
                .sessions()
                .unwrap()
                .registry
                .list(Instant::now())
                .len(),
            1
        );
        assert!(
            !fixture
                .state
                .sessions()
                .unwrap()
                .registry
                .should_shutdown(Instant::now())
        );
        assert_eq!(
            fixture
                .request(
                    "POST",
                    &format!("/r/{second}/api/close"),
                    &[("X-Gitto-Request", "1")],
                    ""
                )
                .await
                .status(),
            StatusCode::OK
        );
        assert!(
            fixture
                .state
                .sessions()
                .unwrap()
                .registry
                .should_shutdown(Instant::now())
        );
        let reloaded =
            Registry::load(fixture.directory.join("registry.json"), Instant::now()).unwrap();
        assert!(reloaded.list(Instant::now()).is_empty());
    }

    #[tokio::test]
    async fn retained_pages_have_a_canonical_url_and_preserve_view_query() {
        let fixture = TestApp::new();
        let id = &fixture.ids[0];
        let response = fixture
            .request("GET", &format!("/r/{id}?rev=topic%2Fone"), &[], "")
            .await;
        assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(
            response.headers()[header::LOCATION],
            format!("/r/{id}/?rev=topic%2Fone")
        );
        let page = fixture.request("GET", &format!("/r/{id}/"), &[], "").await;
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers()[header::CONTENT_TYPE], "text/html");
    }

    #[tokio::test]
    async fn requests_cannot_resurrect_a_server_after_shutdown_is_committed() {
        let fixture = TestApp::new();
        fixture.state.sessions.lock().unwrap().stopping = true;
        for uri in ["/_gitto/health", "/_gitto/repos"] {
            assert_eq!(
                fixture
                    .request("GET", uri, &[("Authorization", "Bearer test-secret")], "")
                    .await
                    .status(),
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
        assert_eq!(
            fixture
                .request(
                    "POST",
                    &format!("/r/{}/api/heartbeat", fixture.ids[0]),
                    &[("X-Gitto-Request", "1")],
                    ""
                )
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn cross_origin_requests_cannot_mutate_local_sessions() {
        let app = Router::new()
            .route("/heartbeat", axum::routing::post(|| async { "active" }))
            .layer(middleware::from_fn_with_state(
                "127.0.0.1:47319".to_owned(),
                protect,
            ));
        for (origin, status) in [
            ("https://evil.example", StatusCode::FORBIDDEN),
            ("null", StatusCode::FORBIDDEN),
            ("http://localhost:47319", StatusCode::FORBIDDEN),
            ("http://127.0.0.1:47319", StatusCode::OK),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/heartbeat")
                        .header(header::HOST, "127.0.0.1:47319")
                        .header(header::ORIGIN, origin)
                        .header("X-Gitto-Request", "1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status, "origin: {origin}");
        }
    }

    #[tokio::test]
    async fn only_the_bound_loopback_host_can_access_content() {
        let app = Router::new().route("/", get(|| async { "repo" })).layer(
            middleware::from_fn_with_state("127.0.0.1:3000".to_owned(), protect),
        );
        for (host, status) in [
            ("evil.example:3000", StatusCode::FORBIDDEN),
            ("localhost:3000", StatusCode::FORBIDDEN),
            ("127.0.0.1:3000", StatusCode::OK),
        ] {
            let request = Request::builder()
                .uri("/")
                .header(header::HOST, host)
                .body(Body::empty())
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), status);
            if status == StatusCode::OK {
                assert_eq!(
                    response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                    "nosniff"
                );
                assert!(
                    !response
                        .headers()
                        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                );
            }
        }
        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
