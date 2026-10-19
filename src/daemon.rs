use std::{
    error::Error,
    fs::{self, File, OpenOptions, TryLockError},
    io::{self, Write},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, StatusCode, body::Bytes, client::conn::http1, header};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{net::TcpStream, time};

use crate::{
    cli::Cli,
    registry::{Registration, RegistrationStatus, Registry},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const PROTOCOL: u32 = 1;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
pub struct ServerFiles {
    pub directory: PathBuf,
    pub registry: PathBuf,
    pub metadata: PathBuf,
    pub log: PathBuf,
}

impl ServerFiles {
    fn in_directory(directory: PathBuf) -> Self {
        Self {
            registry: directory.join("registry.json"),
            metadata: directory.join("runtime.json"),
            log: directory.join("server.log"),
            directory,
        }
    }
}

/// Keep this guard alive until the server has stopped and all persistence has finished.
pub struct CacheLock {
    _file: File,
}

#[derive(Serialize, Deserialize)]
struct RuntimeMetadata {
    protocol: u32,
    version: String,
    port: u16,
    pid: u32,
    token: String,
}

#[derive(Deserialize)]
struct Health {
    protocol: u32,
    version: String,
}

fn cache_directory(port: u16, temporary: PathBuf) -> io::Result<PathBuf> {
    if !temporary.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The temporary directory must be an absolute path; set TMPDIR to an absolute path",
        ));
    }
    // A shared temporary root such as /tmp needs a separate private namespace per user.
    #[cfg(unix)]
    // SAFETY: geteuid has no preconditions or memory effects.
    let namespace = format!("gitto-{}", unsafe { libc::geteuid() });
    #[cfg(not(unix))]
    let namespace = "gitto";
    Ok(temporary.join(namespace).join(port.to_string()))
}

pub fn server_files(port: u16) -> io::Result<ServerFiles> {
    let directory = cache_directory(port, std::env::temp_dir())?;
    let namespace = directory.parent().expect("cache includes a port directory");
    fs::create_dir_all(namespace)?;
    private_directory(namespace)?;
    fs::create_dir_all(&directory)?;
    private_directory(&directory)?;
    Ok(ServerFiles::in_directory(directory))
}

fn private_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The gitto cache must be a directory, not a symbolic link",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions or memory effects.
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "The gitto cache must be owned by the current user",
            ));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_file(path: &Path, append: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).append(append);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions or memory effects.
        if file.metadata()?.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Gitto cache files must be owned by the current user",
            ));
        }
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// The process lock also excludes offline registry readers from persistence.
pub fn cache_lock(files: &ServerFiles) -> io::Result<Option<CacheLock>> {
    let file = private_file(&files.directory.join("server.lock"), false)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(CacheLock { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

async fn startup_lock(files: &ServerFiles) -> io::Result<CacheLock> {
    let path = files.directory.join("startup.lock");
    tokio::task::spawn_blocking(move || {
        let file = private_file(&path, false)?;
        file.lock()?;
        Ok(CacheLock { _file: file })
    })
    .await?
}

/// Call only after holding the process lock and binding the requested port.
pub fn server_token(files: &ServerFiles, port: u16) -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let metadata = RuntimeMetadata {
        protocol: PROTOCOL,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        port,
        pid: std::process::id(),
        token: token.clone(),
    };
    let temporary = files.directory.join("runtime.json.tmp");
    let mut file = private_file(&temporary, false)?;
    file.set_len(0)?;
    serde_json::to_writer(&mut file, &metadata)?;
    file.sync_all()?;
    fs::rename(temporary, &files.metadata)?;
    Ok(token)
}

struct ControlClient {
    port: u16,
    token: String,
}

#[derive(Debug, thiserror::Error)]
enum ControlError {
    #[error("The gitto server is not running")]
    Offline,
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Failed(String),
}

impl ControlError {
    fn retryable(&self) -> bool {
        matches!(self, Self::Offline | Self::Unavailable(_))
    }

    fn transport(error: hyper::Error) -> Self {
        let mut source = error.source();
        while let Some(cause) = source {
            if let Some(io) = cause.downcast_ref::<io::Error>()
                && matches!(
                    io.kind(),
                    io::ErrorKind::ConnectionReset
                        | io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::BrokenPipe
                        | io::ErrorKind::UnexpectedEof
                )
            {
                return Self::Unavailable(error.to_string());
            }
            source = cause.source();
        }
        if error.is_closed() || error.is_incomplete_message() {
            Self::Unavailable(error.to_string())
        } else {
            Self::Failed(error.to_string())
        }
    }
}

impl ControlClient {
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Vec<u8>,
    ) -> std::result::Result<T, ControlError> {
        let request = async {
            let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port))
                .await
                .map_err(|error| {
                    if error.kind() == io::ErrorKind::ConnectionRefused {
                        ControlError::Offline
                    } else {
                        ControlError::Failed(error.to_string())
                    }
                })?;
            let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
                .await
                .map_err(ControlError::transport)?;
            // Drive Hyper and the response together; cancellation drops both without a leaked task.
            let response = async {
                let request = Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::HOST, format!("127.0.0.1:{}", self.port))
                    .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Full::new(Bytes::from(body)))
                    .map_err(|error| ControlError::Failed(error.to_string()))?;
                let response = sender
                    .send_request(request)
                    .await
                    .map_err(ControlError::transport)?;
                let status = response.status();
                let body = response
                    .into_body()
                    .collect()
                    .await
                    .map_err(ControlError::transport)?
                    .to_bytes();
                if status != StatusCode::OK {
                    #[derive(Deserialize)]
                    struct ApiError {
                        error: String,
                    }
                    let detail = serde_json::from_slice::<ApiError>(&body)
                        .map(|error| error.error)
                        .unwrap_or_else(|_| format!("HTTP {status}"));
                    return Err(if status == StatusCode::SERVICE_UNAVAILABLE {
                        ControlError::Unavailable(detail)
                    } else {
                        ControlError::Failed(detail)
                    });
                }
                serde_json::from_slice(&body).map_err(|error| {
                    ControlError::Failed(format!("Invalid gitto response: {error}"))
                })
            };
            tokio::pin!(response);
            tokio::select! {
                biased;
                result = &mut response => result,
                result = connection => match result {
                    Err(error) => Err(ControlError::transport(error)),
                    Ok(()) => response.await,
                },
            }
        };
        time::timeout(REQUEST_TIMEOUT, request)
            .await
            .map_err(|_| ControlError::Failed("The gitto control request timed out".to_owned()))?
    }
}

fn conflict(port: u16, detail: impl std::fmt::Display) -> Box<dyn Error> {
    format!(
        "Port {port} is already in use. Use --port <port> to choose another fixed port. ({detail})"
    )
    .into()
}

fn validate_health(health: &Health) -> Result<()> {
    if health.protocol != PROTOCOL || health.version != env!("CARGO_PKG_VERSION") {
        return Err(format!(
            "Incompatible gitto server: protocol {}, version {} (expected protocol {PROTOCOL}, version {})",
            health.protocol,
            health.version,
            env!("CARGO_PKG_VERSION")
        )
        .into());
    }
    Ok(())
}

async fn unowned_port(port: u16, _guard: CacheLock) -> Result<Option<ControlClient>> {
    // Keep the private process lock while checking occupancy: a public health response alone
    // cannot authenticate an unrelated listener left on a stopped daemon's port.
    match time::timeout(
        REQUEST_TIMEOUT,
        TcpStream::connect((Ipv4Addr::LOCALHOST, port)),
    )
    .await
    {
        Ok(Err(error)) if error.kind() == io::ErrorKind::ConnectionRefused => Ok(None),
        Ok(Ok(_)) => Err(conflict(port, "no gitto process owns the private cache")),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(conflict(port, "the listener did not respond")),
    }
}

async fn probe(files: &ServerFiles, port: u16) -> Result<Option<ControlClient>> {
    let owner = cache_lock(files)?;
    let metadata = match fs::read(&files.metadata) {
        Ok(bytes) => Some(serde_json::from_slice::<RuntimeMetadata>(&bytes)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(guard) = owner {
        return unowned_port(port, guard).await;
    }
    let Some(metadata) = metadata else {
        // A genuine process owns the cache but has not published its startup metadata yet.
        return Ok(None);
    };
    if metadata.port != port || metadata.token.len() != 64 {
        return Err("Invalid private gitto runtime metadata".into());
    }
    let client = ControlClient {
        port,
        token: metadata.token,
    };
    match client
        .request::<Health>(Method::GET, "/_gitto/health", Vec::new())
        .await
    {
        Ok(health) => {
            if let Some(guard) = cache_lock(files)? {
                return unowned_port(port, guard).await;
            }
            validate_health(&health).map_err(|error| conflict(port, error))?;
            Ok(Some(client))
        }
        Err(ControlError::Offline) => Ok(None),
        Err(ControlError::Unavailable(_)) => match cache_lock(files)? {
            Some(guard) => unowned_port(port, guard).await,
            None => Ok(None),
        },
        Err(error) => {
            // A new server binds before atomically publishing its fresh token. Retry only if
            // that publication actually raced this request; unchanged/bad metadata fails fast.
            let current: RuntimeMetadata = serde_json::from_slice(&fs::read(&files.metadata)?)?;
            if current.token != client.token && current.port == port {
                Ok(None)
            } else {
                Err(conflict(port, error))
            }
        }
    }
}

fn spawn_server(files: &ServerFiles, port: u16) -> io::Result<Child> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(["--server", "--port", &port.to_string()])
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(private_file(&files.log, true)?));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and this closure touches no shared state.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command.spawn()
}

async fn ensure_server(files: &ServerFiles, port: u16) -> Result<ControlClient> {
    if let Some(client) = probe(files, port).await? {
        return Ok(client);
    }
    let mut child: Option<Child> = None;
    let ready = time::timeout(STARTUP_TIMEOUT, async {
        loop {
            if let Some(client) = probe(files, port).await? {
                return Ok::<ControlClient, Box<dyn Error>>(client);
            }
            if let Some(child) = child.as_mut() {
                if let Some(status) = child.try_wait()? {
                    return Err(format!("The gitto server exited with {status}").into());
                }
            } else if let Some(guard) = cache_lock(files)? {
                // Wait for any old server's graceful drain, then spawn exactly once under startup.lock.
                drop(guard);
                child = Some(spawn_server(files, port).map_err(|error| {
                    format!(
                        "Could not start gitto: {error}. See {}",
                        files.log.display()
                    )
                })?);
            }
            time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    match ready {
        Ok(Ok(client)) => Ok(client),
        failure => {
            if let Some(child) = child.as_mut() {
                // Do not leave an unready child behind after the bounded startup attempt.
                if child.try_wait()?.is_none() {
                    child.kill()?;
                    child.wait()?;
                }
            }
            let reason = match failure {
                Ok(Err(error)) => error.to_string(),
                Err(_) => "Timed out waiting for the gitto server to become ready".to_owned(),
                Ok(Ok(_)) => unreachable!(),
            };
            Err(format!("{reason}. See {}", files.log.display()).into())
        }
    }
}

fn offline_registrations(files: &ServerFiles) -> Result<Option<Vec<Registration>>> {
    let Some(_guard) = cache_lock(files)? else {
        return Ok(None);
    };
    let now = Instant::now();
    Ok(Some(Registry::load(files.registry.clone(), now)?.list(now)))
}

async fn list_registrations(files: &ServerFiles, port: u16) -> Result<Vec<Registration>> {
    time::timeout(STARTUP_TIMEOUT, async {
        loop {
            // Offline reads do not depend on port occupancy and cannot race registry writes.
            if let Some(registrations) = offline_registrations(files)? {
                return Ok(registrations);
            }
            let client = match probe(files, port).await {
                Ok(client) => client,
                Err(error) => {
                    // The owner can finish shutdown between the first lock check and the probe.
                    return offline_registrations(files)?.ok_or(error);
                }
            };
            if let Some(client) = client {
                match client
                    .request(Method::GET, "/_gitto/repos", Vec::new())
                    .await
                {
                    Ok(registrations) => return Ok(registrations),
                    Err(error) if error.retryable() => {}
                    Err(error) => return Err(Box::new(error) as Box<dyn Error>),
                }
            }
            time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| {
        format!(
            "Timed out waiting to list gitto repositories. See {}",
            files.log.display()
        )
    })?
}

async fn register(files: &ServerFiles, port: u16, path: PathBuf) -> Result<Registration> {
    #[derive(Serialize)]
    struct Register {
        path: PathBuf,
    }
    let body = serde_json::to_vec(&Register { path })?;
    for attempt in 0..3 {
        let client = ensure_server(files, port).await?;
        match client
            .request(Method::POST, "/_gitto/repos", body.clone())
            .await
        {
            Ok(registration) => return Ok(registration),
            Err(error) if error.retryable() && attempt < 2 => {
                time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(format!("{error}. See {}", files.log.display()).into()),
        }
    }
    unreachable!("the final registration attempt always returns")
}

pub async fn run(cli: Cli) -> Result<()> {
    let files = server_files(cli.port)?;
    let startup = startup_lock(&files).await?;
    if cli.list {
        let registrations = list_registrations(&files, cli.port).await?;
        drop(startup);
        let mut output = io::stdout().lock();
        if registrations.is_empty() {
            writeln!(output, "No registered repositories.")?;
        } else {
            writeln!(output, "ID\tSTATUS\tPATH")?;
            for registration in registrations {
                let status = match registration.status {
                    RegistrationStatus::Active => "active",
                    RegistrationStatus::Inactive => "inactive",
                };
                writeln!(
                    output,
                    "{}\t{status}\t{}",
                    registration.id,
                    registration.path.display()
                )?;
            }
        }
        return Ok(());
    }
    // Reuse the backend's read-only identity logic and reject invalid paths before spawning.
    let path = crate::server::repository_path(&cli.path)?;
    let registration = register(&files, cli.port, path).await?;
    drop(startup);
    let url = format!("http://127.0.0.1:{}/r/{}/", cli.port, registration.id);
    println!("gitto: {url}");
    if !cli.no_open
        && let Err(error) = webbrowser::open(&url)
    {
        eprintln!("gitto: could not open the browser: {error}. Open {url} manually.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::Request, routing::any};

    struct TestCache(ServerFiles);

    impl TestCache {
        fn new() -> Self {
            let mut random = [0; 16];
            getrandom::fill(&mut random).unwrap();
            let name: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let directory = std::env::temp_dir().join(format!("gitto-daemon-unit-{name}"));
            fs::create_dir(&directory).unwrap();
            private_directory(&directory).unwrap();
            Self(ServerFiles::in_directory(directory))
        }
    }

    impl Drop for TestCache {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0.directory).unwrap();
        }
    }

    #[test]
    fn private_cache_locks_exclude_other_owners_and_tokens_rotate() {
        let cache = TestCache::new();
        let guard = cache_lock(&cache.0).unwrap().unwrap();
        assert!(cache_lock(&cache.0).unwrap().is_none());
        let token = server_token(&cache.0, 47319).unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let metadata: RuntimeMetadata =
            serde_json::from_slice(&fs::read(&cache.0.metadata).unwrap()).unwrap();
        assert_eq!(metadata.token, token);
        assert_eq!(metadata.protocol, 1);
        assert_eq!(metadata.port, 47319);
        assert_ne!(server_token(&cache.0, 47319).unwrap(), token);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&cache.0.directory)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            for path in [&cache.0.metadata, &cache.0.directory.join("server.lock")] {
                assert_eq!(
                    fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        drop(guard);
        assert!(cache_lock(&cache.0).unwrap().is_some());
    }

    #[tokio::test]
    async fn offline_list_retains_identity_and_never_starts_a_server() {
        let cache = TestCache::new();
        let now = Instant::now();
        let registration = Registry::load(cache.0.registry.clone(), now)
            .unwrap()
            .register(PathBuf::from("/repositories/example"), now)
            .unwrap();
        let before = fs::read(&cache.0.registry).unwrap();
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let entries = list_registrations(&cache.0, port).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, registration.id);
        assert_eq!(entries[0].status, RegistrationStatus::Inactive);
        assert_eq!(fs::read(&cache.0.registry).unwrap(), before);
        assert!(!cache.0.metadata.exists());
        assert!(!cache.0.log.exists());
        assert!(cache_lock(&cache.0).unwrap().is_some());
    }

    #[tokio::test]
    async fn offline_list_ignores_an_unrelated_listener_without_sending_http() {
        let cache = TestCache::new();
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(list_registrations(&cache.0, port).await.unwrap().is_empty());
        assert!(
            time::timeout(Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
        assert!(!cache.0.metadata.exists());
    }

    #[tokio::test]
    async fn stale_metadata_cannot_authenticate_a_foreign_healthy_listener() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let cache = TestCache::new();
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let guard = cache_lock(&cache.0).unwrap().unwrap();
        server_token(&cache.0, port).unwrap();
        drop(guard);
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let app = Router::new().route(
            "/_gitto/health",
            any(move || {
                observed.fetch_add(1, Ordering::SeqCst);
                async {
                    Json(serde_json::json!({"protocol":1,"version":env!("CARGO_PKG_VERSION")}))
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let result = probe(&cache.0, port).await;
        server.abort();
        let _ = server.await;
        assert!(
            result.is_err(),
            "A public health response is not proof of private process ownership"
        );
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("Use --port <port>")
        );
        assert_eq!(
            requests.load(Ordering::SeqCst),
            0,
            "No credential-bearing HTTP request may reach the foreign listener"
        );
    }

    #[tokio::test]
    async fn shutdown_finishing_after_503_is_offline_not_a_port_conflict() {
        let cache = TestCache::new();
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let guard = cache_lock(&cache.0).unwrap().unwrap();
        server_token(&cache.0, port).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            // Finish the old process lifetime before the client consumes its final response.
            drop(listener);
            drop(guard);
            let service = hyper::service::service_fn(|_| async {
                Ok::<_, std::convert::Infallible>(
                    hyper::Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .body(Full::new(Bytes::from_static(
                            b"{\"error\":\"Server is stopping\"}",
                        )))
                        .unwrap(),
                )
            });
            hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await
                .unwrap();
        });
        let result = probe(&cache.0, port).await;
        server.await.unwrap();
        assert!(
            matches!(result, Ok(None)),
            "A closed listener must not produce misleading --port advice"
        );
    }

    #[tokio::test]
    async fn control_transport_sends_exact_host_and_bearer_and_preserves_domain_errors() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route(
            "/{*path}",
            any(move |request: Request| async move {
                assert_eq!(request.headers()[header::HOST], format!("127.0.0.1:{port}"));
                assert_eq!(
                    request.headers()[header::AUTHORIZATION],
                    "Bearer private-token"
                );
                match request.uri().path() {
                    "/_gitto/health" => (
                        StatusCode::OK,
                        Json(serde_json::json!({"protocol":1,"version":env!("CARGO_PKG_VERSION")})),
                    ),
                    "/unavailable" => (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(serde_json::json!({"error":"Server is stopping"})),
                    ),
                    _ => (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({"error":"Repository is missing"})),
                    ),
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ControlClient {
            port,
            token: "private-token".into(),
        };
        let health: Health = client
            .request(Method::GET, "/_gitto/health", Vec::new())
            .await
            .unwrap();
        validate_health(&health).unwrap();
        let error = client
            .request::<Health>(Method::POST, "/invalid", Vec::new())
            .await
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "Repository is missing");
        assert!(!error.retryable());
        assert!(
            client
                .request::<Health>(Method::GET, "/unavailable", Vec::new())
                .await
                .err()
                .unwrap()
                .retryable()
        );
        server.abort();
        let _ = server.await;
    }

    #[test]
    fn server_files_use_os_temporary_storage() {
        let files = server_files(0).unwrap();
        let temporary = std::env::temp_dir();
        #[cfg(unix)]
        // SAFETY: geteuid has no preconditions or memory effects.
        let namespace = format!("gitto-{}", unsafe { libc::geteuid() });
        #[cfg(not(unix))]
        let namespace = "gitto";
        assert_eq!(files.directory, temporary.join(namespace).join("0"));
        assert_eq!(server_files(0).unwrap().directory, files.directory);
        assert_ne!(server_files(1).unwrap().directory, files.directory);
        for path in [&files.registry, &files.metadata, &files.log] {
            assert_eq!(path.parent(), Some(files.directory.as_path()));
        }
    }

    #[test]
    fn temporary_cache_rejects_relative_or_empty_roots() {
        for root in ["relative", ""] {
            assert_eq!(
                cache_directory(47319, PathBuf::from(root))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn incompatible_health_is_not_accepted_as_gitto() {
        assert!(
            validate_health(&Health {
                protocol: 1,
                version: env!("CARGO_PKG_VERSION").into()
            })
            .is_ok()
        );
        assert!(
            validate_health(&Health {
                protocol: 2,
                version: env!("CARGO_PKG_VERSION").into()
            })
            .is_err()
        );
        assert!(
            validate_health(&Health {
                protocol: 1,
                version: "0.0.0".into()
            })
            .is_err()
        );
        assert!(
            conflict(47319, "unknown listener")
                .to_string()
                .contains("Use --port <port>")
        );
    }
}
