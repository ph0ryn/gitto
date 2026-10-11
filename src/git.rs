use git2::{Delta, DiffOptions, ErrorCode, ObjectType, Repository, Status};
use serde::Serialize;
use std::{collections::HashSet, fs, io::Read, path::Path};

use crate::api::{CommitsQuery, DiffQuery, DiffSource, FileQuery, FileSource, RevisionQuery};

const MAX_CONTENT: usize = 2 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("This repository has no working tree")]
    NoWorktree,
    #[error("Only GET requests are supported")]
    MethodNotAllowed,
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Task(#[from] tokio::task::JoinError),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    name: String,
    path: String,
    head: Option<String>,
    bare: bool,
    branches: Vec<Branch>,
}

#[derive(Serialize)]
pub struct Branch {
    name: String,
    revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    id: String,
    short_id: String,
    summary: String,
    message: String,
    author: String,
    time: i64,
    parents: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    commits: Vec<CommitInfo>,
    has_more: bool,
}

#[derive(Serialize)]
pub struct TreeListing {
    entries: Vec<TreeEntry>,
    revision: String,
}

#[derive(Serialize)]
pub struct TreeEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct FileContent {
    path: String,
    kind: &'static str,
    content: Option<String>,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String,
    old_path: Option<String>,
    status: &'static str,
}

#[derive(Default, Serialize)]
pub struct WorkingStatus {
    staged: Vec<Change>,
    unstaged: Vec<Change>,
    untracked: Vec<Change>,
    conflicts: Vec<Change>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    path: String,
    old_path: Option<String>,
    status: &'static str,
    additions: usize,
    deletions: usize,
    binary: bool,
}

#[derive(Serialize)]
pub struct DiffResult {
    patch: String,
    files: Vec<DiffFile>,
    truncated: bool,
}

pub fn validate_path(path: &str, allow_empty: bool) -> Result<&Path, Error> {
    if path.is_empty() && allow_empty {
        return Ok(Path::new(path));
    }
    if path.contains(['\0', '\\'])
        || path.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
        })
    {
        return Err(Error::Invalid(
            "Expected a repository-relative path outside .git".into(),
        ));
    }
    Ok(Path::new(path))
}

fn utf8(bytes: &[u8]) -> Result<&str, Error> {
    std::str::from_utf8(bytes)
        .map_err(|_| Error::Unsupported("Git path or metadata is not UTF-8".into()))
}

fn path_text(path: &Path) -> Result<&str, Error> {
    path.to_str()
        .ok_or_else(|| Error::Unsupported("Git path is not UTF-8".into()))
}

fn commit_at<'a>(repo: &'a Repository, revision: &str) -> Result<Option<git2::Commit<'a>>, Error> {
    if revision.is_empty() || revision.contains('\0') {
        return Err(Error::Invalid("Expected a commit revision".into()));
    }
    match repo.revparse_single(revision) {
        Ok(object) => Ok(Some(object.peel_to_commit()?)),
        Err(error) if revision == "HEAD" && error.code() == ErrorCode::UnbornBranch => Ok(None),
        Err(error) if revision == "HEAD" && error.code() == ErrorCode::NotFound => {
            match repo.head() {
                Err(head_error) if head_error.code() == ErrorCode::UnbornBranch => Ok(None),
                _ => Err(error.into()),
            }
        }
        Err(error) => Err(error.into()),
    }
}

pub fn info(repo: &Repository) -> Result<RepoInfo, Error> {
    let path = repo.workdir().unwrap_or_else(|| repo.path());
    let name = path
        .file_name()
        .ok_or_else(|| Error::Unsupported("Repository has no directory name".into()))?;
    let head = match repo.head() {
        Ok(head) => Some(if repo.head_detached()? {
            head.peel_to_commit()?.id().to_string()[..7].to_owned()
        } else {
            utf8(head.shorthand_bytes())?.to_owned()
        }),
        Err(error) if error.code() == ErrorCode::UnbornBranch => None,
        Err(error) => return Err(error.into()),
    };
    let mut branches = Vec::new();
    for reference in repo.references()? {
        let reference = reference?;
        if reference.is_branch() || reference.is_remote() || reference.is_tag() {
            let name = utf8(reference.shorthand_bytes())?;
            branches.push(Branch {
                name: if reference.is_tag() {
                    format!("tag: {name}")
                } else {
                    name.to_owned()
                },
                revision: utf8(reference.name_bytes())?.to_owned(),
            });
        }
    }
    branches.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(RepoInfo {
        name: name
            .to_str()
            .ok_or_else(|| Error::Unsupported("Repository name is not UTF-8".into()))?
            .to_owned(),
        path: path_text(path)?.to_owned(),
        head,
        bare: repo.is_bare(),
        branches,
    })
}

pub fn commits(repo: &Repository, query: CommitsQuery) -> Result<History, Error> {
    if !(1..=100).contains(&query.limit) {
        return Err(Error::Invalid("limit must be between 1 and 100".into()));
    }
    let mut commits = Vec::new();
    let Some(commit) = commit_at(repo, &query.revision)? else {
        return Ok(History {
            commits,
            has_more: false,
        });
    };
    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    walk.push(commit.id())?;
    let mut page = walk.skip(query.offset);
    for oid in page.by_ref().take(query.limit) {
        let commit = repo.find_commit(oid?)?;
        let id = commit.id().to_string();
        let message = utf8(commit.message_bytes())?.to_owned();
        commits.push(CommitInfo {
            short_id: id[..7].to_owned(),
            id,
            summary: message.lines().next().unwrap_or("").to_owned(),
            message,
            author: utf8(commit.author().name_bytes())?.to_owned(),
            time: commit.time().seconds(),
            parents: commit.parent_ids().map(|id| id.to_string()).collect(),
        });
    }
    let has_more = match page.next() {
        Some(oid) => {
            oid?;
            true
        }
        None => false,
    };
    Ok(History { commits, has_more })
}

pub fn tree(repo: &Repository, query: RevisionQuery) -> Result<TreeListing, Error> {
    validate_path(&query.path, true)?;
    let Some(commit) = commit_at(repo, &query.revision)? else {
        return Ok(TreeListing {
            entries: Vec::new(),
            revision: query.revision,
        });
    };
    let root = commit.tree()?;
    let tree = if query.path.is_empty() {
        root
    } else {
        root.get_path(Path::new(&query.path))?
            .to_object(repo)?
            .peel_to_tree()?
    };
    let mut entries = Vec::new();
    for entry in &tree {
        let name = utf8(entry.name_bytes())?.to_owned();
        let path = if query.path.is_empty() {
            name.clone()
        } else {
            format!("{}/{name}", query.path)
        };
        let kind = match (entry.kind(), entry.filemode()) {
            (Some(ObjectType::Tree), _) => "tree",
            (_, 0o120000) => "symlink",
            (Some(ObjectType::Commit), _) => "submodule",
            (Some(ObjectType::Blob), _) => "blob",
            _ => return Err(Error::Unsupported("Unsupported Git tree entry".into())),
        };
        let size = if entry.kind() == Some(ObjectType::Blob) {
            Some(repo.odb()?.read_header(entry.id())?.0)
        } else {
            None
        };
        entries.push(TreeEntry {
            name,
            path,
            kind,
            size,
        });
    }
    entries.sort_by(|a, b| (a.kind != "tree", &a.name).cmp(&(b.kind != "tree", &b.name)));
    Ok(TreeListing {
        entries,
        revision: commit.id().to_string(),
    })
}

fn binary_content(bytes: &[u8]) -> bool {
    // Match libgit2's blob heuristic without creating a blob in the repository.
    let sample = &bytes[..bytes.len().min(8000)];
    let sample = sample.strip_prefix(b"\xef\xbb\xbf").unwrap_or(sample);
    let mut printable = 0;
    let mut nonprintable = 0;
    for &byte in sample {
        if byte == 0 {
            return true;
        }
        if (byte > 31 && byte != 127) || matches!(byte, 8 | 27 | 12) {
            printable += 1;
        } else if !matches!(byte, b'\t'..=b'\r' | b' ') {
            nonprintable += 1;
        }
    }
    nonprintable > printable >> 7
}

fn content(path: String, bytes: &[u8], size: u64) -> FileContent {
    content_with_limit(path, bytes, size, true)
}

fn content_with_limit(path: String, bytes: &[u8], size: u64, limited: bool) -> FileContent {
    if limited && size > MAX_CONTENT as u64 {
        return FileContent {
            path,
            kind: "tooLarge",
            content: None,
            size,
        };
    }
    match std::str::from_utf8(bytes) {
        Ok(text) if !binary_content(bytes) => FileContent {
            path,
            kind: "text",
            content: Some(text.to_owned()),
            size,
        },
        _ => FileContent {
            path,
            kind: "binary",
            content: None,
            size,
        },
    }
}

pub fn file(repo: &Repository, query: FileQuery) -> Result<FileContent, Error> {
    let path = validate_path(&query.path, false)?;
    let (oid, mode) = match query.source {
        FileSource::Worktree => return worktree_file(repo, &query.path, true),
        FileSource::Index => {
            let index = repo.index()?;
            let entry = index.get_path(path, 0).ok_or_else(|| {
                Error::NotFound("File is not in the index (or is conflicted)".into())
            })?;
            (entry.id, entry.mode)
        }
        FileSource::Commit => {
            let commit = commit_at(repo, &query.revision)?
                .ok_or_else(|| Error::NotFound("Repository has no commits".into()))?;
            let entry = commit.tree()?.get_path(path)?;
            (entry.id(), entry.filemode() as u32)
        }
    };
    if mode == 0o160000 {
        return Ok(FileContent {
            path: query.path,
            kind: "submodule",
            content: Some(oid.to_string()),
            size: 0,
        });
    }
    let size = repo.odb()?.read_header(oid)?.0;
    if size > MAX_CONTENT {
        return Ok(content(query.path, &[], size as u64));
    }
    let blob = repo.find_blob(oid)?;
    Ok(content(query.path, blob.content(), blob.size() as u64))
}

fn worktree_file(repo: &Repository, path: &str, limited: bool) -> Result<FileContent, Error> {
    let root = repo.workdir().ok_or(Error::NoWorktree)?.canonicalize()?;
    let index = repo.index()?;
    for stage in 0..=3 {
        if let Some(entry) = index.get_path(Path::new(path), stage)
            && entry.mode == 0o160000
        {
            return Ok(FileContent {
                path: path.into(),
                kind: "submodule",
                content: Some(entry.id.to_string()),
                size: 0,
            });
        }
    }
    let full = root.join(path);
    // Resolve the parent, but display a symlink's target instead of following it.
    let parent = full
        .parent()
        .ok_or_else(|| Error::Invalid("Invalid path".into()))?
        .canonicalize()?;
    let relative = parent
        .strip_prefix(&root)
        .map_err(|_| Error::Invalid("Path leaves the repository".into()))?;
    validate_path(path_text(relative)?, true)?;
    let metadata = fs::symlink_metadata(&full)?;
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(&full)?;
        let bytes = path_text(&target)?.as_bytes();
        return Ok(content_with_limit(
            path.to_owned(),
            bytes,
            bytes.len() as u64,
            limited,
        ));
    }
    if !metadata.is_file() {
        return Err(Error::Invalid("Expected a regular file or symlink".into()));
    }
    if limited && metadata.len() > MAX_CONTENT as u64 {
        return Ok(content(path.to_owned(), &[], metadata.len()));
    }
    let mut bytes = Vec::new();
    fs::File::open(full)?
        .take(if limited {
            MAX_CONTENT as u64 + 1
        } else {
            u64::MAX
        })
        .read_to_end(&mut bytes)?;
    Ok(content_with_limit(
        path.to_owned(),
        &bytes,
        bytes.len() as u64,
        limited,
    ))
}

pub fn status_name(status: Status, staged: bool, intent_to_add: bool) -> Option<&'static str> {
    if staged && intent_to_add {
        return None;
    }
    if !staged && intent_to_add && !status.contains(Status::WT_DELETED) {
        return Some("added");
    }
    if !staged && !intent_to_add && status.contains(Status::WT_NEW) {
        return None;
    }
    let flags = if staged {
        [
            Status::INDEX_NEW,
            Status::INDEX_DELETED,
            Status::INDEX_RENAMED,
            Status::INDEX_TYPECHANGE,
        ]
    } else {
        [
            Status::WT_NEW,
            Status::WT_DELETED,
            Status::WT_RENAMED,
            Status::WT_TYPECHANGE,
        ]
    };
    for (flag, name) in flags
        .into_iter()
        .zip(["added", "deleted", "renamed", "typechange"])
    {
        if status.contains(flag) {
            return Some(name);
        }
    }
    let modified = if staged {
        Status::INDEX_MODIFIED
    } else {
        Status::WT_MODIFIED
    };
    status.contains(modified).then_some("modified")
}

fn change(delta: &git2::DiffDelta<'_>, status: &'static str) -> Result<Change, Error> {
    let path = delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .ok_or_else(|| Error::Unsupported("Diff has no path".into()))?;
    let path = path_text(path)?.to_owned();
    let old_path = if delta.status() == Delta::Renamed {
        delta
            .old_file()
            .path()
            .map(path_text)
            .transpose()?
            .map(str::to_owned)
    } else {
        None
    };
    Ok(Change {
        path,
        old_path,
        status,
    })
}

pub fn status(repo: &Repository) -> Result<WorkingStatus, Error> {
    if repo.is_bare() {
        return Ok(WorkingStatus::default());
    }
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let mut result = WorkingStatus::default();
    let index = repo.index()?;
    let conflicts = index.conflicts()?.collect::<Result<Vec<_>, _>>()?;
    let mut conflict_paths = Vec::new();
    for conflict in &conflicts {
        let entry = conflict_entry(conflict)?;
        result.conflicts.push(Change {
            path: utf8(&entry.path)?.into(),
            old_path: None,
            status: "conflicted",
        });
        for entry in [&conflict.our, &conflict.their, &conflict.ancestor]
            .into_iter()
            .flatten()
        {
            conflict_paths.push((utf8(&entry.path)?.to_owned(), entry.mode == 0o160000));
        }
    }
    for entry in repo.statuses(Some(&mut options))?.iter() {
        let flags = entry.status();
        let intent = index
            .get_path(Path::new(utf8(entry.path_bytes())?), 0)
            .is_some_and(|entry| {
                git2::IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended)
                    .is_intent_to_add()
            });
        let entry_path = utf8(entry.path_bytes())?.trim_end_matches('/');
        if flags.contains(Status::CONFLICTED)
            || conflict_paths.iter().any(|(path, submodule)| {
                entry_path == path || (*submodule && entry_path.starts_with(&format!("{path}/")))
            })
        {
            continue;
        }
        if let Some(name) = status_name(flags, true, intent) {
            let delta = entry
                .head_to_index()
                .ok_or_else(|| Error::Unsupported("Staged status has no diff".into()))?;
            result.staged.push(change(&delta, name)?);
        }
        if let Some(name) = status_name(flags, false, intent) {
            let delta = entry
                .index_to_workdir()
                .or_else(|| if intent { entry.head_to_index() } else { None })
                .ok_or_else(|| Error::Unsupported("Unstaged status has no diff".into()))?;
            result.unstaged.push(change(&delta, name)?);
        }
        if flags.contains(Status::WT_NEW) && !intent {
            let delta = entry
                .index_to_workdir()
                .ok_or_else(|| Error::Unsupported("Untracked status has no diff".into()))?;
            result.untracked.push(change(&delta, "untracked")?);
        }
        if flags.contains(Status::WT_UNREADABLE) {
            return Err(Error::Unsupported(format!(
                "Unreadable file: {}",
                utf8(entry.path_bytes())?
            )));
        }
    }
    Ok(result)
}

fn delta_name(status: Delta) -> &'static str {
    match status {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        Delta::Untracked => "untracked",
        Delta::Conflicted => "conflicted",
        _ => "modified",
    }
}

pub fn diff(repo: &Repository, query: DiffQuery) -> Result<DiffResult, Error> {
    let mut options = DiffOptions::new();
    options
        .include_typechange(true)
        .max_size(if query.stats_only {
            -1
        } else {
            MAX_CONTENT as i64
        });
    if let Some(path) = &query.path {
        validate_path(path, false)?;
    }
    let mut index = if query.source != DiffSource::Commit && !repo.is_bare() {
        Some(repo.index()?)
    } else {
        None
    };
    let mut intent_paths = HashSet::new();
    if let Some(index) = &index {
        for entry in index.iter() {
            if git2::IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended)
                .is_intent_to_add()
            {
                intent_paths.insert(utf8(&entry.path)?.to_owned());
            }
        }
    }
    let mut diff = match query.source {
        DiffSource::Staged => {
            if repo.is_bare() {
                return Err(Error::NoWorktree);
            }
            let head = commit_at(repo, "HEAD")?
                .map(|commit| commit.tree())
                .transpose()?;
            repo.diff_tree_to_index(head.as_ref(), None, Some(&mut options))?
        }
        DiffSource::Unstaged | DiffSource::Untracked => {
            if repo.is_bare() {
                return Err(Error::NoWorktree);
            }
            if query.source == DiffSource::Untracked {
                options
                    .include_untracked(true)
                    .recurse_untracked_dirs(true)
                    .show_untracked_content(true);
            }
            if query.source == DiffSource::Unstaged
                && let Some(index) = &mut index
            {
                // Change only the in-memory index; intent-to-add files compare against absence.
                for path in &intent_paths {
                    index.remove_path(Path::new(path))?;
                }
                options
                    .include_untracked(true)
                    .recurse_untracked_dirs(true)
                    .show_untracked_content(true);
            }
            repo.diff_index_to_workdir(index.as_ref(), Some(&mut options))?
        }
        DiffSource::Commit => {
            let commit = commit_at(repo, &query.revision)?
                .ok_or_else(|| Error::NotFound("Repository has no commits".into()))?;
            let parent = if commit.parent_count() == 0 {
                None
            } else {
                Some(commit.parent(0)?.tree()?)
            };
            repo.diff_tree_to_tree(parent.as_ref(), Some(&commit.tree()?), Some(&mut options))?
        }
    };
    diff.find_similar(Some(
        git2::DiffFindOptions::new()
            .renames(true)
            .for_untracked(matches!(
                query.source,
                DiffSource::Unstaged | DiffSource::Untracked
            )),
    ))?;
    let mut result = DiffResult {
        patch: String::new(),
        files: Vec::new(),
        truncated: false,
    };
    for (index, delta) in diff.deltas().enumerate() {
        if delta.status() == Delta::Conflicted {
            continue;
        }
        if query.source == DiffSource::Untracked && delta.status() != Delta::Untracked {
            continue;
        }
        let intent = delta
            .new_file()
            .path()
            .map(path_text)
            .transpose()?
            .is_some_and(|path| intent_paths.contains(path));
        if query.source == DiffSource::Staged && intent {
            continue;
        }
        if query.source == DiffSource::Unstaged && delta.status() == Delta::Untracked && !intent {
            continue;
        }
        // Filter after rename detection so both sides of a rename remain available.
        if let Some(path) = &query.path
            && delta.new_file().path() != Some(Path::new(path))
            && delta.old_file().path() != Some(Path::new(path))
        {
            continue;
        }
        let entry = change(
            &delta,
            if intent && query.source == DiffSource::Unstaged && delta.status() == Delta::Untracked
            {
                "added"
            } else {
                delta_name(delta.status())
            },
        )?;
        let mut patch = git2::Patch::from_diff(&diff, index)?;
        let (additions, deletions) = match &patch {
            Some(patch) => {
                let (_, additions, deletions) = patch.line_stats()?;
                (additions, deletions)
            }
            None => (0, 0),
        };
        let file = DiffFile {
            path: entry.path,
            old_path: entry.old_path,
            status: entry.status,
            additions,
            deletions,
            binary: delta.flags().contains(git2::DiffFlags::BINARY),
        };
        append_file(&mut result, file, patch.as_mut(), query.stats_only)?;
        if result.truncated {
            break;
        }
    }
    if query.source == DiffSource::Unstaged
        && !result.truncated
        && let Some(index) = &index
    {
        append_conflicts(
            repo,
            index,
            query.path.as_deref(),
            &mut result,
            query.stats_only,
        )?;
    }
    Ok(result)
}

fn conflict_entry(conflict: &git2::IndexConflict) -> Result<&git2::IndexEntry, Error> {
    conflict
        .our
        .as_ref()
        .or(conflict.their.as_ref())
        .or(conflict.ancestor.as_ref())
        .ok_or_else(|| Error::Unsupported("Conflict has no index entries".into()))
}

fn append_file(
    result: &mut DiffResult,
    file: DiffFile,
    patch: Option<&mut git2::Patch<'_>>,
    stats_only: bool,
) -> Result<(), Error> {
    result.files.push(file);
    if !stats_only && let Some(patch) = patch {
        append_patch(result, patch)?;
    }
    Ok(())
}

fn append_patch(result: &mut DiffResult, patch: &mut git2::Patch<'_>) -> Result<(), Error> {
    let mut failure = None;
    let printed =
        patch.print(
            &mut |_, _, line| match append_line(result, line.origin(), line.content()) {
                Ok(keep_going) => keep_going,
                Err(error) => {
                    failure = Some(error);
                    false
                }
            },
        );
    if let Some(error) = failure {
        return Err(error);
    }
    printed.or_else(|error| {
        if result.truncated && error.code() == ErrorCode::User {
            Ok(())
        } else {
            Err(error)
        }
    })?;
    Ok(())
}

fn append_line(result: &mut DiffResult, origin: char, bytes: &[u8]) -> Result<bool, Error> {
    let prefix = match origin {
        '+' | '-' | ' ' => Some(origin),
        _ => None,
    };
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Error::Unsupported("Diff text is not UTF-8".into()))?;
    if result.patch.len() + text.len() + usize::from(prefix.is_some()) > MAX_CONTENT {
        result.truncated = true;
        return Ok(false);
    }
    if let Some(prefix) = prefix {
        result.patch.push(prefix);
    }
    result.patch.push_str(text);
    Ok(true)
}

fn append_conflicts(
    repo: &Repository,
    index: &git2::Index,
    path: Option<&str>,
    result: &mut DiffResult,
    stats_only: bool,
) -> Result<(), Error> {
    for conflict in index.conflicts()? {
        let conflict = conflict?;
        let entry = conflict_entry(&conflict)?;
        let conflict_path = utf8(&entry.path)?;
        if path.is_some_and(|path| path != conflict_path) {
            continue;
        }
        let submodule = [&conflict.our, &conflict.their, &conflict.ancestor]
            .into_iter()
            .flatten()
            .any(|entry| entry.mode == 0o160000);
        let mut file = DiffFile {
            path: conflict_path.into(),
            old_path: None,
            status: if submodule {
                "submodule-conflicted"
            } else {
                "conflicted"
            },
            additions: 0,
            deletions: 0,
            binary: submodule,
        };
        if submodule {
            result.files.push(file);
            continue;
        }
        let old = match conflict.our.as_ref() {
            Some(entry) => {
                let size = repo.odb()?.read_header(entry.id)?.0;
                if !stats_only && size > MAX_CONTENT {
                    file.binary = true;
                    result.files.push(file);
                    continue;
                }
                Some(repo.find_blob(entry.id)?)
            }
            None => None,
        };
        let new = match worktree_file(repo, conflict_path, !stats_only) {
            Ok(file) => file,
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                content(conflict_path.into(), &[], 0)
            }
            Err(error) => return Err(error),
        };
        if new.kind != "text" || old.as_ref().is_some_and(|blob| blob.is_binary()) {
            file.binary = true;
            result.files.push(file);
            continue;
        }
        // Conflicts compare stage 2 (ours) with the current file, including conflict markers.
        let old_bytes = old.as_ref().map_or(&[][..], |blob| blob.content());
        let new_bytes = new
            .content
            .as_deref()
            .ok_or_else(|| Error::Unsupported("Text content is missing".into()))?
            .as_bytes();
        let mut options = DiffOptions::new();
        options.max_size(if stats_only { -1 } else { MAX_CONTENT as i64 });
        let mut patch = git2::Patch::from_buffers(
            old_bytes,
            Some(Path::new(conflict_path)),
            new_bytes,
            Some(Path::new(conflict_path)),
            Some(&mut options),
        )?;
        let (_, additions, deletions) = patch.line_stats()?;
        file.additions = additions;
        file.deletions = deletions;
        append_file(result, file, Some(&mut patch), stats_only)?;
        if result.truncated {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statistics_only_keep_file_counts_without_serializing_the_patch() {
        let mut result = DiffResult {
            patch: String::new(),
            files: Vec::new(),
            truncated: false,
        };
        let mut patch = git2::Patch::from_buffers(
            b"old\n",
            Some(Path::new("file")),
            b"new\n",
            Some(Path::new("file")),
            None,
        )
        .unwrap();
        let file = DiffFile {
            path: "file".into(),
            old_path: None,
            status: "modified",
            additions: 1,
            deletions: 1,
            binary: false,
        };
        append_file(&mut result, file, Some(&mut patch), true).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].additions, 1);
        assert_eq!(result.files[0].deletions, 1);
        assert!(result.patch.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn repository_paths_allow_unicode_and_reject_traversal_and_metadata() {
        assert_eq!(
            validate_path("src/日本語.rs", false).unwrap(),
            Path::new("src/日本語.rs")
        );
        for path in [
            "../secret",
            "/etc/passwd",
            "src/../secret",
            ".git/config",
            "src/.git/config",
            "src\\secret",
            "a\0b",
            "",
        ] {
            assert!(validate_path(path, false).is_err(), "{path:?}");
        }
        assert!(validate_path("", true).is_ok());
    }

    #[test]
    fn one_file_can_have_separate_staged_and_unstaged_status() {
        let status = git2::Status::INDEX_NEW | git2::Status::WT_MODIFIED;
        assert_eq!(status_name(status, true, false), Some("added"));
        assert_eq!(status_name(status, false, false), Some("modified"));
    }

    #[test]
    fn deleted_renamed_and_type_changes_are_preserved() {
        assert_eq!(
            status_name(git2::Status::INDEX_DELETED, true, false),
            Some("deleted")
        );
        assert_eq!(
            status_name(git2::Status::WT_RENAMED, false, false),
            Some("renamed")
        );
        assert_eq!(
            status_name(git2::Status::INDEX_TYPECHANGE, true, false),
            Some("typechange")
        );
    }

    #[test]
    fn intent_to_add_is_only_an_unstaged_addition() {
        let flags = Status::INDEX_NEW | Status::WT_MODIFIED;
        assert_eq!(status_name(flags, true, true), None);
        assert_eq!(status_name(flags, false, true), Some("added"));
        assert_eq!(status_name(Status::WT_NEW, false, false), None);
    }

    #[test]
    fn file_view_distinguishes_utf8_binary_and_oversized_content() {
        let text = content("note.txt".into(), "日本語\n".as_bytes(), 10);
        assert_eq!(text.kind, "text");
        assert_eq!(text.content.as_deref(), Some("日本語\n"));
        assert_eq!(content("binary".into(), b"a\0b", 3).kind, "binary");
        assert_eq!(content("binary".into(), &[0xff], 1).kind, "binary");
        assert_eq!(content("binary".into(), &[1, 2, 3, 127], 4).kind, "binary");
        assert_eq!(content("text".into(), b"a\t\r\n", 4).kind, "text");
        assert_eq!(content("text".into(), b"\xef\xbb\xbfhello", 8).kind, "text");
        assert_eq!(content("empty".into(), &[], 0).content.as_deref(), Some(""));
        let large = content("large".into(), &[], MAX_CONTENT as u64 + 1);
        assert_eq!(large.kind, "tooLarge");
        assert!(large.content.is_none());
    }

    #[test]
    fn statistics_content_keeps_large_text_while_preview_remains_limited() {
        let bytes = vec![b'x'; MAX_CONTENT + 1];
        let size = bytes.len() as u64;
        assert_eq!(content("large".into(), &bytes, size).kind, "tooLarge");
        let text = content_with_limit("large".into(), &bytes, size, false);
        assert_eq!(text.kind, "text");
        assert_eq!(text.content.unwrap().len(), bytes.len());
        assert_eq!(
            content_with_limit("binary".into(), b"a\0b", 3, false).kind,
            "binary"
        );
    }

    #[test]
    fn patch_output_preserves_line_origins_and_stops_before_the_size_limit() {
        let mut result = DiffResult {
            patch: String::new(),
            files: Vec::new(),
            truncated: false,
        };
        assert!(append_line(&mut result, 'F', b"diff --git a/a b/a\n").unwrap());
        assert!(append_line(&mut result, '+', "日本語\n".as_bytes()).unwrap());
        assert!(result.patch.ends_with("+日本語\n"));
        result.patch = "x".repeat(MAX_CONTENT - 1);
        assert!(!append_line(&mut result, '+', b"x").unwrap());
        assert!(result.truncated);
        assert_eq!(result.patch.len(), MAX_CONTENT - 1);
        assert!(append_line(&mut result, '+', &[0xff]).is_err());
    }
}
