import { useCallback, useEffect, useMemo, useState } from "react";
import FileTree, { EntryIcon, mergeLocalEntries, type TreeEntry } from "./fileTree";
import CodeViewer from "./codeViewer";
import DiffViewer, { type DiffFile, type DiffView } from "./diffViewer";
import { lineChanges, type LineChange } from "./diffLines";
import ChangeTree, {
  buildChangeTree,
  buildChangeDecorations,
  changeKey,
  type ChangeEntry,
} from "./changeTree";

type Branch = { name: string; revision: string };
type Repo = {
  name: string;
  path: string;
  head: string | null;
  bare: boolean;
  branches: Branch[];
};
type Commit = {
  id: string;
  shortId: string;
  summary: string;
  message: string;
  author: string;
  time: number;
  parents: string[];
};
type StatusEntry = {
  path: string;
  oldPath: string | null;
  status: string;
  stats?: ChangeEntry["stats"];
};
type Status = {
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: StatusEntry[];
  conflicts: StatusEntry[];
};
type FileView = {
  path: string;
  kind: "text" | "binary" | "tooLarge" | "submodule";
  content: string | null;
  size: number;
  changes?: LineChange[];
  changesTruncated?: boolean;
  removed?: boolean;
};
type ChangeSource = ChangeEntry["source"];

const EMPTY_STATUS: Status = {
  staged: [],
  unstaged: [],
  untracked: [],
  conflicts: [],
};

async function api<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await (signal ? fetch(url, { signal }) : fetch(url));
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

async function loadStatus(signal?: AbortSignal): Promise<Status> {
  const status = await api<Status>("/api/status", signal);
  const [stagedStats, unstagedStats] = await Promise.all(
    (["staged", "unstaged"] as const).map(async (source) => {
      const entries =
        source === "staged" ? status.staged : [...status.unstaged, ...status.conflicts];
      if (entries.length === 0) return new Map<string, DiffFile>();
      const diff = await api<DiffView>(`/api/diff?source=${source}&statsOnly=true`, signal);
      return new Map(diff.files.map((file) => [file.path, file]));
    }),
  );
  function withStats(entries: StatusEntry[], files: Map<string, DiffFile>) {
    return entries.map((entry) => {
      const file = files.get(entry.path);
      if (!file) throw new Error(`Diff statistics are missing for ${entry.path}.`);
      return { ...entry, stats: file };
    });
  }
  return {
    ...status,
    staged: withStats(status.staged, stagedStats),
    unstaged: withStats(status.unstaged, unstagedStats),
    conflicts: withStats(status.conflicts, unstagedStats),
  };
}

async function loadFile(
  entry: TreeEntry,
  revision: string,
  status: Status,
  local: boolean,
  signal?: AbortSignal,
): Promise<FileView> {
  const untracked = status.untracked.some((file) => file.path === entry.path);
  const removed =
    local &&
    !untracked &&
    [...status.staged, ...status.unstaged].some(
      (file) =>
        (file.path === entry.path && file.status === "deleted") ||
        (file.oldPath === entry.path && file.status === "renamed"),
    );
  const source = removed
    ? entry.local &&
      status.staged.some(
        (file) => file.path === entry.path && ["added", "renamed", "copied"].includes(file.status),
      )
      ? "index"
      : "commit"
    : local
      ? "worktree"
      : "commit";
  const data = await api<FileView>(
    `/api/file?source=${source}&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
    signal,
  );
  if (data.kind === "text") {
    if (data.content === null) throw new Error("Text content is missing.");
    const count = Math.max(
      1,
      data.content.split("\n").length - Number(data.content.endsWith("\n")),
    );
    if (removed) {
      data.removed = true;
      data.changes = [{ line: 1, endLine: count, kind: "deleted" }];
    } else {
      const diff = await api<DiffView>(
        `/api/diff?source=${local ? "worktree" : "commit"}&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
        signal,
      );
      data.changes = lineChanges(diff.patch, count);
      data.changesTruncated = diff.truncated;
    }
  }
  return data;
}

function formatDate(seconds: number) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(seconds * 1000));
}

function formatBytes(size: number | null) {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export default function App() {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [status, setStatus] = useState<Status>(EMPTY_STATUS);
  const [revision, setRevision] = useState("HEAD");
  const [historyRevision, setHistoryRevision] = useState("HEAD");
  const [historyPages, setHistoryPages] = useState(1);
  const [selectedBranchRevision, setSelectedBranchRevision] = useState("");
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitChanges, setCommitChanges] = useState<ChangeEntry[]>([]);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [fileEntry, setFileEntry] = useState<TreeEntry | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [viewLabel, setViewLabel] = useState("Select a file");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setBusy(true);
    setError(null);
    try {
      const repoData = await api<Repo>("/api/repo");
      const requestRevision = "HEAD";
      const [commitData, treeData, statusData] = await Promise.all([
        api<{ commits: Commit[]; hasMore: boolean }>(
          `/api/commits?revision=${requestRevision}&offset=0&limit=50`,
        ),
        api<{ entries: TreeEntry[]; revision: string }>(
          `/api/tree?revision=${requestRevision}&path=`,
        ),
        loadStatus(),
      ]);
      setRepo(repoData);
      setCommits(commitData.commits);
      setHasMore(commitData.hasMore);
      setTree(treeData.entries);
      setStatus(statusData);
      setRevision(requestRevision);
      setHistoryRevision(requestRevision);
      setHistoryPages(1);
      setSelectedBranchRevision(
        repoData.branches.find((branch) => branch.name === repoData.head)?.revision ?? "HEAD",
      );
      setSelectedCommit(null);
      setCommitChanges([]);
      setSelectedChange(null);
      setFileView(null);
      setDiffView(null);
      setViewLabel("Select a file");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the repository.");
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (repo) document.title = `${repo.name} | gitto`;
  }, [repo]);

  const ready = Boolean(repo) && !loading && !busy;
  const openFilePath = fileView?.path;
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    let previewController: AbortController | null = null;
    let workspaceError: string | null = null;
    let previewError: string | null = null;
    let disposed = false;

    async function refreshPreview(repoData: Repo, statusData: Status) {
      if (previewController || selectedCommit || (!openFilePath && !selectedChange)) return;
      previewController = new AbortController();
      const { signal } = previewController;
      try {
        if (openFilePath && fileEntry) {
          const local =
            !repoData.bare &&
            (revision === "HEAD" ||
              revision ===
                repoData.branches.find((branch) => branch.name === repoData.head)?.revision);
          const data = await loadFile(fileEntry, revision, statusData, local, signal);
          if (signal.aborted) return;
          setFileView(data);
        } else if (selectedChange) {
          const source = selectedChange.slice(0, selectedChange.indexOf(":"));
          const data = await api<DiffView>(
            `/api/diff?source=${source}&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(viewLabel)}`,
            signal,
          );
          if (signal.aborted) return;
          setDiffView(data);
        }
        previewError = null;
        setError(workspaceError);
      } catch (reason) {
        if (!signal.aborted) {
          previewError =
            reason instanceof Error ? reason.message : "Could not refresh the preview.";
          setError(workspaceError ?? previewError);
        }
      } finally {
        previewController = null;
      }
    }

    async function refresh() {
      if (document.hidden || controller) return;
      controller = new AbortController();
      const { signal } = controller;
      try {
        const repoData = await api<Repo>("/api/repo", signal);
        if (signal.aborted) return;
        setRepo(repoData);
        const [pages, treeData, statusData] = await Promise.all([
          Promise.all(
            Array.from({ length: historyPages }, (_, page) =>
              api<{ commits: Commit[]; hasMore: boolean }>(
                `/api/commits?revision=${encodeURIComponent(historyRevision)}&offset=${page * 50}&limit=50`,
                signal,
              ),
            ),
          ),
          api<{ entries: TreeEntry[] }>(
            `/api/tree?revision=${encodeURIComponent(revision)}&path=`,
            signal,
          ),
          loadStatus(signal),
        ]);
        if (signal.aborted) return;
        setCommits(pages.flatMap((page) => page.commits));
        setHasMore(pages[pages.length - 1].hasMore);
        setTree(treeData.entries);
        setStatus(statusData);
        if (historyRevision === "HEAD") {
          setSelectedBranchRevision(
            repoData.branches.find((branch) => branch.name === repoData.head)?.revision ?? "HEAD",
          );
        }
        setRefreshVersion((current) => current + 1);
        workspaceError = null;
        setError(previewError);
        void refreshPreview(repoData, statusData);
      } catch (reason) {
        if (!signal.aborted) {
          workspaceError =
            reason instanceof Error ? reason.message : "Could not refresh the repository.";
          setError(workspaceError);
        }
      } finally {
        controller = null;
        if (!disposed) timer = setTimeout(() => void refresh(), 2000);
      }
    }

    function resume() {
      clearTimeout(timer);
      if (document.hidden) {
        controller?.abort();
        previewController?.abort();
      } else void refresh();
    }

    timer = setTimeout(() => void refresh(), 2000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      previewController?.abort();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [
    ready,
    historyRevision,
    revision,
    historyPages,
    selectedCommit,
    selectedChange,
    openFilePath,
    fileEntry,
    viewLabel,
  ]);

  const loadChildren = useCallback(
    async (entry: TreeEntry) => {
      const data = await api<{ entries: TreeEntry[] }>(
        `/api/tree?revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
      );
      return data.entries;
    },
    [revision],
  );

  async function chooseCommit(commit: Commit) {
    setBusy(true);
    setError(null);
    setFileView(null);
    setDiffView(null);
    setSelectedChange(null);
    setViewLabel("Loading…");
    try {
      const [treeData, diffData] = await Promise.all([
        api<{ entries: TreeEntry[] }>(`/api/tree?revision=${encodeURIComponent(commit.id)}&path=`),
        api<DiffView>(`/api/diff?source=commit&revision=${encodeURIComponent(commit.id)}`),
      ]);
      const changesData = diffData.truncated
        ? await api<DiffView>(
            `/api/diff?source=commit&revision=${encodeURIComponent(commit.id)}&statsOnly=true`,
          )
        : diffData;
      setTree(treeData.entries);
      setDiffView(diffData);
      setRevision(commit.id);
      setSelectedCommit(commit.id);
      setCommitChanges(
        changesData.files.map((file) => ({ ...file, source: "commit", stats: file })),
      );
      setViewLabel(`${commit.shortId} changes`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the commit.");
      setViewLabel("Select a file");
      setDiffView(null);
    } finally {
      setBusy(false);
    }
  }

  async function chooseBranch(branch: Branch) {
    setBusy(true);
    setError(null);
    setFileView(null);
    setDiffView(null);
    setSelectedChange(null);
    setViewLabel("Loading…");
    try {
      const [commitData, treeData] = await Promise.all([
        api<{ commits: Commit[]; hasMore: boolean }>(
          `/api/commits?revision=${encodeURIComponent(branch.revision)}&offset=0&limit=50`,
        ),
        api<{ entries: TreeEntry[] }>(
          `/api/tree?revision=${encodeURIComponent(branch.revision)}&path=`,
        ),
      ]);
      setCommits(commitData.commits);
      setHasMore(commitData.hasMore);
      setTree(treeData.entries);
      setRevision(branch.revision);
      setHistoryRevision(branch.revision);
      setHistoryPages(1);
      setSelectedBranchRevision(branch.revision);
      setSelectedCommit(null);
      setCommitChanges([]);
      setFileView(null);
      setDiffView(null);
      setViewLabel("Select a file");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the branch.");
      setViewLabel("Select a file");
    } finally {
      setBusy(false);
    }
  }

  async function chooseHead() {
    setBusy(true);
    setError(null);
    setFileView(null);
    setDiffView(null);
    setSelectedChange(null);
    setViewLabel("Loading…");
    try {
      const [commitData, treeData] = await Promise.all([
        api<{ commits: Commit[]; hasMore: boolean }>(
          "/api/commits?revision=HEAD&offset=0&limit=50",
        ),
        api<{ entries: TreeEntry[] }>("/api/tree?revision=HEAD&path="),
      ]);
      setCommits(commitData.commits);
      setHasMore(commitData.hasMore);
      setTree(treeData.entries);
      setRevision("HEAD");
      setHistoryRevision("HEAD");
      setHistoryPages(1);
      setSelectedBranchRevision("HEAD");
      setSelectedCommit(null);
      setCommitChanges([]);
      setViewLabel("Select a file");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load HEAD.");
      setViewLabel("Select a file");
    } finally {
      setBusy(false);
    }
  }

  async function openEntry(entry: TreeEntry) {
    setBusy(true);
    setError(null);
    setDiffView(null);
    setFileView(null);
    setSelectedChange(null);
    setViewLabel("Loading…");
    try {
      const data = await loadFile(entry, revision, status, viewingHead && !repo?.bare);
      setFileView(data);
      setFileEntry(entry);
      setViewLabel(entry.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the file.");
      setViewLabel("Select a file");
    } finally {
      setBusy(false);
    }
  }

  async function openChange(source: ChangeSource, entry: StatusEntry) {
    setBusy(true);
    setError(null);
    setFileView(null);
    setDiffView(null);
    setSelectedChange(null);
    setViewLabel("Loading…");
    try {
      const data = await api<DiffView>(
        `/api/diff?source=${source}&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
      );
      setDiffView(data);
      setSelectedChange(changeKey({ ...entry, source }));
      setViewLabel(entry.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the diff.");
      setViewLabel("Select a file");
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    setBusy(true);
    try {
      const data = await api<{ commits: Commit[]; hasMore: boolean }>(
        `/api/commits?revision=${encodeURIComponent(historyRevision)}&offset=${commits.length}&limit=50`,
      );
      setCommits((current) => [...current, ...data.commits]);
      setHistoryPages(Math.ceil((commits.length + data.commits.length) / 50));
      setHasMore(data.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load history.");
    } finally {
      setBusy(false);
    }
  }

  const changeGroups = useMemo(() => {
    const tracked: ChangeEntry[] = [
      ...status.staged.map((entry) => ({ ...entry, source: "staged" as const })),
      ...status.unstaged.map((entry) => ({ ...entry, source: "unstaged" as const })),
      ...status.conflicts.map((entry) => ({ ...entry, source: "unstaged" as const })),
    ];
    const untracked: ChangeEntry[] = status.untracked.map((entry) => ({
      ...entry,
      source: "untracked",
    }));
    const groups = selectedCommit
      ? [{ label: "Commit", entries: commitChanges }]
      : [
          { label: "Tracked", entries: tracked },
          { label: "Untracked", entries: untracked },
        ];
    return groups
      .filter((group) => group.entries.length > 0)
      .map((group) => ({
        label: group.label,
        nodes: buildChangeTree(group.entries),
        decorations: buildChangeDecorations(group.entries),
      }));
  }, [status, selectedCommit, commitChanges]);
  const fileDecorations = useMemo(
    () => buildChangeDecorations(Object.values(status).flat()),
    [status],
  );
  const viewingHead =
    revision === "HEAD" ||
    revision === repo?.branches.find((branch) => branch.name === repo.head)?.revision;
  const localPaths = viewingHead
    ? [...status.untracked, ...status.staged, ...status.unstaged]
        .filter((entry) => ["untracked", "added", "renamed", "copied"].includes(entry.status))
        .map((entry) => entry.path)
    : [];
  const fileCount = mergeLocalEntries(tree, localPaths).length;
  const showHeadOption = Boolean(
    repo && (!repo.head || !repo.branches.some((branch) => branch.name === repo.head)),
  );

  if (loading) {
    return (
      <div className="app-state">
        <div className="loading-block" />
        <p>Loading repository…</p>
      </div>
    );
  }

  if (error && !repo) {
    return (
      <div className="app-state error-state">
        <strong>Could not load repository</strong>
        <p>{error}</p>
        <button onClick={() => void loadWorkspace()}>Retry</button>
      </div>
    );
  }

  const changeCount = selectedCommit
    ? commitChanges.length
    : Object.values(status).reduce((sum, entries) => sum + entries.length, 0);
  const hasView = Boolean(fileView || diffView);

  return (
    <main className="app-shell">
      <div className="workspace">
        <aside className="files-column" aria-label="File tree">
          <div className="column-heading branch-heading">
            <svg
              className="ui-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="6" cy="5" r="2" />
              <circle cx="6" cy="19" r="2" />
              <circle cx="18" cy="5" r="2" />
              <path d="M6 7v10M18 7a9 9 0 0 1-9 9H6" />
            </svg>
            <select
              aria-label="Branch"
              value={selectedCommit ?? selectedBranchRevision}
              onChange={(event) => {
                if (event.target.value === "HEAD") {
                  void chooseHead();
                  return;
                }
                const branch = repo?.branches.find((item) => item.revision === event.target.value);
                if (branch) void chooseBranch(branch);
              }}
              disabled={busy || (!repo?.branches.length && !repo?.head)}
            >
              {selectedCommit && (
                <option value={selectedCommit}>Commit {selectedCommit.slice(0, 8)}</option>
              )}
              {showHeadOption && <option value="HEAD">HEAD</option>}
              {repo?.branches.length
                ? repo.branches.map((branch) => (
                    <option key={branch.revision} value={branch.revision}>
                      {branch.name}
                    </option>
                  ))
                : !showHeadOption && <option value="HEAD">No branches</option>}
            </select>
          </div>
          <div className="pane-toolbar">
            <h2>{repo?.name}</h2>
          </div>
          <div className="pane-scroll tree-content">
            {fileCount === 0 ? (
              <EmptyState title="No files" detail="This revision has no files to display." />
            ) : (
              <FileTree
                key={revision}
                entries={tree}
                selectedPath={fileView?.path}
                decorations={viewingHead ? fileDecorations : undefined}
                localPaths={localPaths}
                refreshVersion={refreshVersion}
                disabled={busy}
                loadChildren={loadChildren}
                onSelect={(entry) => void openEntry(entry)}
                onError={setError}
              />
            )}
          </div>
        </aside>
        <section className="viewer-column" aria-label="Repository content" aria-busy={busy}>
          <header className="viewer-heading">
            {hasView && (
              <>
                {fileView && <EntryIcon kind="blob" />}
                <h2 title={viewLabel} aria-label={viewLabel}>
                  <span className="viewer-directory">
                    {viewLabel.slice(0, viewLabel.lastIndexOf("/") + 1)}
                  </span>
                  <span className="viewer-filename">
                    {viewLabel.slice(viewLabel.lastIndexOf("/") + 1)}
                  </span>
                </h2>
                <button
                  className="icon-button"
                  aria-label="Close view"
                  title="Close view"
                  disabled={busy}
                  onClick={() => {
                    setFileView(null);
                    setDiffView(null);
                    setSelectedChange(null);
                    setViewLabel("Select a file");
                  }}
                >
                  <svg
                    className="ui-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <path d="m7 7 10 10M7 17 17 7" />
                  </svg>
                </button>
              </>
            )}
          </header>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="pane-scroll viewer-content">
            {busy ? (
              <div className="viewer-loading">Loading…</div>
            ) : diffView ? (
              <DiffViewer view={diffView} />
            ) : fileView ? (
              <FileViewer file={fileView} />
            ) : (
              <EmptyState
                title="Open a file"
                detail="Choose a file from the tree, or select a change or commit to view its diff."
              />
            )}
          </div>
        </section>
        <aside className="changes-column" aria-label="Changed files" aria-busy={busy}>
          <div className="column-heading">
            <h2>Changes</h2>
            <span>{changeCount}</span>
          </div>
          <div className="pane-scroll changes-list">
            {repo?.bare && !selectedCommit ? (
              <EmptyState
                title="No working tree"
                detail="Committed files are available to browse."
              />
            ) : changeCount === 0 ? (
              <EmptyState
                title="No changes"
                detail={
                  selectedCommit ? "This commit has no file changes." : "The working tree is clean."
                }
              />
            ) : (
              changeGroups.map((group) => (
                <details key={group.label} className="change-group" open>
                  <summary>{group.label}</summary>
                  <ChangeTree
                    nodes={group.nodes}
                    disabled={busy}
                    selected={selectedChange}
                    decorations={group.decorations}
                    onSelect={(entry) => void openChange(entry.source, entry)}
                  />
                </details>
              ))
            )}
          </div>
        </aside>

        <aside className="history-column" aria-label="Commit history">
          <div className="column-heading">
            <h2>Commits</h2>
            <span>{commits.length}</span>
          </div>
          <div className="pane-scroll history-content">
            {commits.length === 0 ? (
              <EmptyState title="No commits" detail="HEAD has not been created yet." />
            ) : (
              <div className="commit-list">
                {commits.map((commit) => (
                  <button
                    key={commit.id}
                    className={`commit-row ${selectedCommit === commit.id ? "is-selected" : ""}`}
                    onClick={() => void chooseCommit(commit)}
                    disabled={busy}
                    title={commit.message}
                    aria-pressed={selectedCommit === commit.id}
                  >
                    <span className="commit-line" aria-hidden="true" />
                    <span className="commit-copy">
                      <strong>{commit.summary || "(No message)"}</strong>
                      <small>
                        <code>{commit.shortId}</code>
                        <span>{commit.author}</span>
                      </small>
                    </span>
                    <time dateTime={new Date(commit.time * 1000).toISOString()}>
                      {formatDate(commit.time)}
                    </time>
                  </button>
                ))}
                {hasMore && (
                  <button className="load-more" onClick={() => void loadMore()} disabled={busy}>
                    Load more
                  </button>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
      <footer className="repo-footer" aria-label="Repository path">
        <span className="repo-path" title={repo?.path}>
          {repo?.path}
        </span>
        <span className="footer-meta">
          <span className="readonly-label">Read-only</span>
          {fileView && <span>{formatBytes(fileView.size)}</span>}
          <span title={selectedCommit ?? commits[0]?.id}>
            {selectedCommit
              ? `Commit ${selectedCommit.slice(0, 8)}`
              : revision === "HEAD"
                ? `HEAD${commits[0] ? ` · ${commits[0].shortId}` : " (unborn)"}`
                : commits[0]?.shortId}
          </span>
        </span>
      </footer>
    </main>
  );
}

function FileViewer({ file }: { file: FileView }) {
  if (file.kind === "binary")
    return (
      <EmptyState
        title="Binary file"
        detail={`This ${formatBytes(file.size)} binary file cannot be previewed.`}
      />
    );
  if (file.kind === "tooLarge")
    return (
      <EmptyState
        title="File is too large"
        detail={`The file (${formatBytes(file.size)}) exceeds the preview limit.`}
      />
    );
  if (file.kind === "submodule")
    return (
      <EmptyState title="Submodule" detail="Submodule contents belong to a separate repository." />
    );
  if (file.content === null) throw new Error("Text content is missing.");
  return (
    <>
      {(file.removed || file.changesTruncated) && (
        <div className="diff-summary">
          {file.removed && <span>Removed from working tree</span>}
          {file.changesTruncated && (
            <span className="diff-truncated">Change markers truncated</span>
          )}
        </div>
      )}
      <CodeViewer content={file.content} path={file.path} changes={file.changes} />
    </>
  );
}
