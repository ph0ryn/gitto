use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use std::sync::Arc;
use tokio::net::TcpListener;

use crate::{
    api::{self, AppState},
    assets,
    cli::Cli,
};

pub async fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let repository = git2::Repository::discover(&cli.path)?;
    let path = repository.path().canonicalize()?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, cli.port)).await?;
    let address = listener.local_addr()?;
    let url = format!("http://{address}");
    let state = AppState {
        repository: Arc::new(path),
    };
    let app = Router::new()
        .nest("/api", api::routes())
        .fallback(assets::serve)
        .with_state(state)
        .layer(middleware::from_fn_with_state(address.to_string(), protect));

    println!("gitto: {url}\nPress Ctrl+C to stop.");
    if !cli.no_open
        && let Err(error) = webbrowser::open(&url)
    {
        eprintln!("gitto: could not open the browser: {error}. Open {url} manually.");
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            if let Err(error) = tokio::signal::ctrl_c().await {
                eprintln!("gitto: could not receive Ctrl+C: {error}");
            }
        })
        .await?;
    Ok(())
}

fn valid_host(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        == Some(expected)
}

async fn protect(State(host): State<String>, request: Request, next: Next) -> Response {
    // Reject DNS rebinding: only the loopback URL we printed may access this server.
    if !valid_host(request.headers(), &host) {
        return (StatusCode::FORBIDDEN, "Invalid Host").into_response();
    }
    let mut response = next.run(request).await;
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
