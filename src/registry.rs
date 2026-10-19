use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
pub const IDLE_GRACE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Repository registration not found")]
    NotFound,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Could not generate a registration ID: {0}")]
    Random(getrandom::Error),
    #[error("Invalid registry: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RegistrationStatus {
    Active,
    Inactive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registration {
    pub id: String,
    pub path: PathBuf,
    pub status: RegistrationStatus,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CachedRegistration {
    id: String,
    path: PathBuf,
}

pub struct Registry {
    file: PathBuf,
    entries: Vec<CachedRegistration>,
    sessions: HashMap<String, Instant>,
    startup: Option<Instant>,
}

impl Registry {
    /// Load identities only. Cached entries never restore a session or idle timer.
    pub fn load(file: PathBuf, now: Instant) -> Result<Self, Error> {
        let entries: Vec<CachedRegistration> = match fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        let mut ids = HashSet::new();
        let mut paths = HashSet::new();
        for entry in &entries {
            if entry.id.len() != 32
                || !entry
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(Error::Invalid(
                    "expected a 32-character lowercase hex ID".into(),
                ));
            }
            if !entry.path.is_absolute() {
                return Err(Error::Invalid("repository paths must be absolute".into()));
            }
            if !ids.insert(&entry.id) || !paths.insert(&entry.path) {
                return Err(Error::Invalid("duplicate repository ID or path".into()));
            }
        }
        Ok(Self {
            file,
            entries,
            sessions: HashMap::new(),
            startup: Some(now),
        })
    }

    /// The caller supplies the canonical worktree or bare repository root.
    pub fn register(&mut self, path: PathBuf, now: Instant) -> Result<Registration, Error> {
        if !path.is_absolute() {
            return Err(Error::Invalid("repository paths must be absolute".into()));
        }
        let id = if let Some(entry) = self.entries.iter().find(|entry| entry.path == path) {
            entry.id.clone()
        } else {
            let id = loop {
                let candidate = random_id()?;
                if !self.entries.iter().any(|entry| entry.id == candidate) {
                    break candidate;
                }
            };
            let mut entries = self.entries.clone();
            entries.push(CachedRegistration {
                id: id.clone(),
                path: path.clone(),
            });
            self.persist(&entries)?;
            self.entries = entries;
            id
        };
        self.sessions.insert(id.clone(), now);
        self.startup = None;
        Ok(Registration {
            id,
            path,
            status: RegistrationStatus::Active,
        })
    }

    pub fn heartbeat(&mut self, id: &str, now: Instant) -> Result<(), Error> {
        if !self.entries.iter().any(|entry| entry.id == id) {
            return Err(Error::NotFound);
        }
        self.sessions.insert(id.to_owned(), now);
        self.startup = None;
        Ok(())
    }

    pub fn close(&mut self, id: &str) -> Result<(), Error> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.id == id)
            .ok_or(Error::NotFound)?;
        let mut entries = self.entries.clone();
        entries.remove(index);
        self.persist(&entries)?;
        self.entries = entries;
        self.sessions.remove(id);
        Ok(())
    }

    pub fn repository(&self, id: &str) -> Result<PathBuf, Error> {
        self.entries
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.path.clone())
            .ok_or(Error::NotFound)
    }

    pub fn list(&self, now: Instant) -> Vec<Registration> {
        self.entries
            .iter()
            .map(|entry| Registration {
                id: entry.id.clone(),
                path: entry.path.clone(),
                status: if self
                    .sessions
                    .get(&entry.id)
                    .is_some_and(|last_seen| now < *last_seen + HEARTBEAT_TIMEOUT)
                {
                    RegistrationStatus::Active
                } else {
                    RegistrationStatus::Inactive
                },
            })
            .collect()
    }

    pub fn should_shutdown(&self, now: Instant) -> bool {
        if self
            .startup
            .is_some_and(|started| now < started + HEARTBEAT_TIMEOUT)
        {
            return false;
        }
        // Implicit grace starts at the heartbeat deadline, not when it is observed.
        !self
            .sessions
            .values()
            .any(|last_seen| now < *last_seen + HEARTBEAT_TIMEOUT + IDLE_GRACE)
    }

    fn persist(&self, entries: &[CachedRegistration]) -> Result<(), Error> {
        let bytes = serde_json::to_vec(entries)?;
        let parent = self
            .file
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let mut directory = DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(parent)?;

        let temporary = parent.join(format!(".registry-{}.tmp", random_id()?));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary)?;
        let result = (|| {
            output.write_all(&bytes)?;
            output.sync_all()?;
            drop(output);
            fs::rename(&temporary, &self.file)
        })();
        if let Err(error) = result {
            fs::remove_file(&temporary)?;
            return Err(error.into());
        }
        Ok(())
    }
}

fn random_id() -> Result<String, Error> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(Error::Random)?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut id = String::with_capacity(32);
    for byte in bytes {
        id.push(HEX[(byte >> 4) as usize] as char);
        id.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "gitto-registry-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self) -> PathBuf {
            self.0.join("registry.json")
        }

        fn repository(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            assert!(
                self.0
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("gitto-registry-")
            );
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn registrations_have_stable_opaque_ids_and_only_identity_is_persisted() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut registry = Registry::load(directory.file(), now).unwrap();
        let path = directory.repository("one");
        let first = registry.register(path.clone(), now).unwrap();
        assert_eq!(first.path, path);
        assert_eq!(first.status, RegistrationStatus::Active);
        assert_eq!(first.id.len(), 32);
        assert!(
            first
                .id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        let again = registry
            .register(path.clone(), now + Duration::from_secs(10))
            .unwrap();
        assert_eq!(again.id, first.id);
        let second = registry.register(directory.repository("two"), now).unwrap();
        assert_ne!(second.id, first.id);
        assert_eq!(registry.repository(&first.id).unwrap(), path);

        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.file()).unwrap()).unwrap();
        let entries = persisted.as_array().unwrap();
        assert_eq!(entries.len(), 2);
        for entry in entries {
            let object = entry.as_object().unwrap();
            assert_eq!(object.len(), 2);
            assert!(object.contains_key("id"));
            assert!(object.contains_key("path"));
        }
        let json = serde_json::to_value(&first).unwrap();
        assert_eq!(json["status"], "active");
        assert_eq!(serde_json::from_value::<Registration>(json).unwrap(), first);
    }

    #[test]
    fn fresh_process_has_only_thirty_seconds_of_startup_grace() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let registry = Registry::load(directory.file(), now).unwrap();
        assert!(registry.list(now).is_empty());
        assert!(!directory.file().exists());
        assert!(!registry.should_shutdown(now + HEARTBEAT_TIMEOUT - Duration::from_nanos(1)));
        assert!(registry.should_shutdown(now + HEARTBEAT_TIMEOUT));
    }

    #[test]
    fn loaded_cache_is_inactive_and_never_restores_runtime_timers() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut original = Registry::load(directory.file(), now).unwrap();
        let registration = original.register(directory.repository("one"), now).unwrap();
        let restarted = now + Duration::from_secs(5);
        let mut loaded = Registry::load(directory.file(), restarted).unwrap();
        assert_eq!(loaded.list(restarted).len(), 1);
        assert_eq!(loaded.list(restarted)[0].id, registration.id);
        assert_eq!(
            loaded.list(restarted)[0].status,
            RegistrationStatus::Inactive
        );
        assert!(!loaded.should_shutdown(restarted));
        assert!(loaded.should_shutdown(restarted + HEARTBEAT_TIMEOUT));
        let again = loaded.register(registration.path, restarted).unwrap();
        assert_eq!(again.id, registration.id);
        assert_eq!(again.status, RegistrationStatus::Active);
    }

    #[test]
    fn pending_registration_times_out_then_has_one_hour_from_its_deadline() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut registry = Registry::load(directory.file(), now).unwrap();
        registry.register(directory.repository("one"), now).unwrap();
        let deadline = now + HEARTBEAT_TIMEOUT;
        assert_eq!(
            registry.list(deadline - Duration::from_nanos(1))[0].status,
            RegistrationStatus::Active
        );
        assert_eq!(
            registry.list(deadline)[0].status,
            RegistrationStatus::Inactive
        );
        assert!(!registry.should_shutdown(deadline));
        assert!(!registry.should_shutdown(deadline + IDLE_GRACE - Duration::from_nanos(1)));
        assert!(registry.should_shutdown(deadline + IDLE_GRACE));
        assert_eq!(registry.list(deadline + IDLE_GRACE).len(), 1);
    }

    #[test]
    fn heartbeat_extends_deadline_and_reconnect_reactivates_cached_id() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut registry = Registry::load(directory.file(), now).unwrap();
        let registration = registry.register(directory.repository("one"), now).unwrap();
        let heartbeat = now + Duration::from_secs(20);
        registry.heartbeat(&registration.id, heartbeat).unwrap();
        assert_eq!(
            registry.list(now + HEARTBEAT_TIMEOUT)[0].status,
            RegistrationStatus::Active
        );
        let deadline = heartbeat + HEARTBEAT_TIMEOUT;
        assert_eq!(
            registry.list(deadline)[0].status,
            RegistrationStatus::Inactive
        );
        assert!(registry.should_shutdown(deadline + IDLE_GRACE));

        let mut loaded = Registry::load(directory.file(), deadline).unwrap();
        let reconnect = deadline + Duration::from_secs(10);
        loaded.heartbeat(&registration.id, reconnect).unwrap();
        assert_eq!(loaded.list(reconnect)[0].status, RegistrationStatus::Active);
        assert!(!loaded.should_shutdown(deadline + HEARTBEAT_TIMEOUT));
        assert!(loaded.should_shutdown(reconnect + HEARTBEAT_TIMEOUT + IDLE_GRACE));
    }

    #[test]
    fn reregistering_inactive_path_reuses_id_and_resets_runtime_deadline() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut registry = Registry::load(directory.file(), now).unwrap();
        let path = directory.repository("one");
        let first = registry.register(path.clone(), now).unwrap();
        let later = now + HEARTBEAT_TIMEOUT + IDLE_GRACE;
        assert!(registry.should_shutdown(later));
        let again = registry.register(path, later).unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(again.status, RegistrationStatus::Active);
        assert!(!registry.should_shutdown(later));
        assert!(registry.should_shutdown(later + HEARTBEAT_TIMEOUT + IDLE_GRACE));
    }

    #[test]
    fn close_removes_registration_and_all_of_its_runtime_grace() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut registry = Registry::load(directory.file(), now).unwrap();
        let path = directory.repository("one");
        let first = registry.register(path.clone(), now).unwrap();
        registry.close(&first.id).unwrap();
        assert!(registry.list(now).is_empty());
        assert!(registry.should_shutdown(now));
        assert!(matches!(
            registry.repository(&first.id),
            Err(Error::NotFound)
        ));
        assert!(matches!(
            registry.heartbeat(&first.id, now),
            Err(Error::NotFound)
        ));
        assert!(
            Registry::load(directory.file(), now)
                .unwrap()
                .list(now)
                .is_empty()
        );
        let second = registry.register(path, now).unwrap();
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn multiple_sessions_keep_their_own_grace_and_close_does_not_create_one() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut registry = Registry::load(directory.file(), now).unwrap();
        let first = registry.register(directory.repository("one"), now).unwrap();
        let later = now + Duration::from_secs(10);
        let second = registry
            .register(directory.repository("two"), later)
            .unwrap();
        let statuses: Vec<_> = registry
            .list(now + HEARTBEAT_TIMEOUT)
            .into_iter()
            .map(|registration| registration.status)
            .collect();
        assert_eq!(
            statuses,
            vec![RegistrationStatus::Inactive, RegistrationStatus::Active]
        );
        assert!(!registry.should_shutdown(now + HEARTBEAT_TIMEOUT + IDLE_GRACE));
        registry.close(&second.id).unwrap();
        assert!(!registry.should_shutdown(now + HEARTBEAT_TIMEOUT));
        assert!(registry.should_shutdown(now + HEARTBEAT_TIMEOUT + IDLE_GRACE));
        registry.close(&first.id).unwrap();
        assert!(registry.should_shutdown(later));
    }

    #[test]
    fn old_cached_entries_do_not_keep_last_closed_live_session_running() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut original = Registry::load(directory.file(), now).unwrap();
        let first = original.register(directory.repository("one"), now).unwrap();
        let second = original.register(directory.repository("two"), now).unwrap();
        let mut loaded = Registry::load(directory.file(), now).unwrap();
        loaded.heartbeat(&first.id, now).unwrap();
        loaded.close(&first.id).unwrap();
        assert_eq!(loaded.list(now)[0].id, second.id);
        assert!(loaded.should_shutdown(now));
    }

    #[test]
    fn unknown_ids_are_distinguishable_errors_without_side_effects() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut registry = Registry::load(directory.file(), now).unwrap();
        assert!(matches!(
            registry.repository("unknown"),
            Err(Error::NotFound)
        ));
        assert!(matches!(
            registry.heartbeat("unknown", now),
            Err(Error::NotFound)
        ));
        assert!(matches!(registry.close("unknown"), Err(Error::NotFound)));
        assert!(!directory.file().exists());
        assert!(!registry.should_shutdown(now));
    }

    #[test]
    fn corrupt_cache_and_io_errors_propagate_without_resetting_data() {
        let directory = TestDirectory::new();
        let corrupt = b"not JSON";
        fs::write(directory.file(), corrupt).unwrap();
        assert!(matches!(
            Registry::load(directory.file(), Instant::now()),
            Err(Error::Json(_))
        ));
        assert_eq!(fs::read(directory.file()).unwrap(), corrupt);
        assert!(matches!(
            Registry::load(directory.0.clone(), Instant::now()),
            Err(Error::Io(_))
        ));
    }

    #[test]
    fn invalid_persisted_identity_is_rejected_instead_of_repaired() {
        let directory = TestDirectory::new();
        let valid_id = "0123456789abcdef0123456789abcdef";
        let path = directory.repository("one");
        let valid = serde_json::json!({ "id": valid_id, "path": path });
        let invalid_caches = [
            serde_json::json!([{ "id": "../../invalid", "path": path }]),
            serde_json::json!([{ "id": valid_id, "path": "relative" }]),
            serde_json::json!([valid.clone(), valid.clone()]),
            serde_json::json!([
                valid.clone(),
                { "id": "abcdef0123456789abcdef0123456789", "path": path }
            ]),
            serde_json::json!([
                valid,
                { "id": valid_id, "path": directory.repository("two") }
            ]),
        ];
        for cache in invalid_caches {
            let bytes = serde_json::to_vec(&cache).unwrap();
            fs::write(directory.file(), &bytes).unwrap();
            assert!(matches!(
                Registry::load(directory.file(), Instant::now()),
                Err(Error::Invalid(_))
            ));
            assert_eq!(fs::read(directory.file()).unwrap(), bytes);
        }
    }

    #[test]
    fn relative_registration_path_is_rejected_without_creating_cache() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut registry = Registry::load(directory.file(), now).unwrap();
        assert!(matches!(
            registry.register(PathBuf::from("relative"), now),
            Err(Error::Invalid(_))
        ));
        assert!(registry.list(now).is_empty());
        assert!(!directory.file().exists());
    }

    #[test]
    fn failed_persistence_does_not_publish_registration_or_remove_existing_one() {
        let directory = TestDirectory::new();
        let now = Instant::now();
        let mut registry = Registry::load(directory.file(), now).unwrap();
        let first = registry.register(directory.repository("one"), now).unwrap();
        let file = directory.file();
        assert_eq!(file.parent(), Some(directory.0.as_path()));
        assert_eq!(file.file_name().unwrap(), "registry.json");
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();

        assert!(matches!(
            registry.register(directory.repository("two"), now),
            Err(Error::Io(_))
        ));
        assert_eq!(registry.list(now), vec![first.clone()]);
        assert!(matches!(registry.close(&first.id), Err(Error::Io(_))));
        assert_eq!(registry.repository(&first.id).unwrap(), first.path);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_cache_writes_use_private_permissions_and_leave_no_temp_files() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let file = directory.0.join("private").join("registry.json");
        let now = Instant::now();
        let mut registry = Registry::load(file.clone(), now).unwrap();
        registry.register(directory.repository("one"), now).unwrap();
        registry.register(directory.repository("two"), now).unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let parent = file.parent().unwrap();
        assert_eq!(
            fs::metadata(parent).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
    }
}
