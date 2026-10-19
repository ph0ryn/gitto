import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "./api";
import ChangeTree, {
  buildChangeTree,
  buildChangeDecorations,
  changeKey,
  type ChangeEntry,
} from "./changeTree";
import CodeViewer, { MAX_HIGHLIGHT_BYTES } from "./codeViewer";
import { lineChanges, type LineChange } from "./diffLines";
import DiffViewer, { type DiffFile, type DiffView } from "./diffViewer";
import EntryIcon from "./entryIcon";
import FileTree, { mergeLocalEntries, type TreeEntry } from "./fileTree";
import { RepositoryCloseButton } from "./repositorySession";
import SearchResults, { type SearchResult } from "./searchResults";
import { readViewLocation, writeViewLocation } from "./viewLocation";

type Branch = { name: string; revision: string };
type Repo = {
  appVersion: string;
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

async function loadStatus(signal?: AbortSignal): Promise<Status> {
  const status = await api<Status>("/api/status", signal);
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all(
    (["staged", "unstaged", "untracked"] as const).map(async (source) => {
      const entries =
        source === "unstaged" ? [...status.unstaged, ...status.conflicts] : status[source];
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
    untracked: withStats(status.untracked, untrackedStats),
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
      data.changesTruncated = diff.truncated || diff.files.some((file) => file.tooLarge);
    }
  }
  return data;
}

function formatDateTime(seconds: number) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
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

function isHeadRevision(revision: string, repo: Repo | null) {
  return (
    revision === "HEAD" ||
    revision === repo?.branches.find((branch) => branch.name === repo.head)?.revision
  );
}

function localFilePaths(status: Status) {
  return [...status.untracked, ...status.staged, ...status.unstaged]
    .filter((entry) => ["untracked", "added", "renamed", "copied"].includes(entry.status))
    .map((entry) => entry.path);
}

async function findFileEntry(
  path: string,
  entries: TreeEntry[],
  revision: string,
  localPaths: string[],
  signal: AbortSignal,
): Promise<TreeEntry> {
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const parent = parts.slice(0, index).join("/");
    const child = parts.slice(0, index + 1).join("/");
    const entry = mergeLocalEntries(entries, localPaths, parent).find(
      (item) => item.path === child,
    );
    if (!entry || (index === parts.length - 1 ? entry.kind === "tree" : entry.kind !== "tree")) {
      throw new Error(`File not found: ${path}`);
    }
    if (index === parts.length - 1) return entry;
    entries = entry.local
      ? []
      : (
          await api<{ entries: TreeEntry[] }>(
            `/api/tree?revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
            signal,
          )
        ).entries;
  }
  throw new Error(`File not found: ${path}`);
}

async function loadCommitView(revision: string, signal?: AbortSignal) {
  const query = `source=commit&revision=${encodeURIComponent(revision)}`;
  const diff = await api<DiffView>(`/api/diff?${query}`, signal);
  const stats = diff.truncated
    ? await api<DiffView>(`/api/diff?${query}&statsOnly=true`, signal)
    : diff;
  return {
    diff,
    changes: stats.files.map((file): ChangeEntry => ({ ...file, source: "commit", stats: file })),
  };
}

export default function App() {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [commitTotal, setCommitTotal] = useState(0);
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
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRequest = useRef<AbortController | null>(null);
  const workspaceRequest = useRef<AbortController | null>(null);
  const navigationVersion = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchVersion, setSearchVersion] = useState(0);
  const [focusLine, setFocusLine] = useState<number | undefined>();
  const viewingHead = isHeadRevision(revision, repo);
  const searchSource = viewingHead && !repo?.bare ? "worktree" : "commit";

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (searchQuery === null) return;
    const controller = new AbortController();
    setSearchResult(null);
    setSearchError(null);
    void api<SearchResult>(
      `/api/search?source=${searchSource}&revision=${encodeURIComponent(revision)}&query=${encodeURIComponent(searchQuery)}`,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setSearchResult(data);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setSearchError(
            reason instanceof Error ? reason.message : "Could not search the repository.",
          );
      });
    return () => controller.abort();
  }, [searchQuery, searchSource, revision, searchVersion]);

  const loadWorkspace = useCallback(async () => {
    navigationVersion.current++;
    workspaceRequest.current?.abort();
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreviewLoading(false);
    const controller = new AbortController();
    workspaceRequest.current = controller;
    const { signal } = controller;
    setLoading(true);
    setBusy(true);
    setError(null);
    try {
      const location = readViewLocation();
      const requestRevision = location.commit ?? location.revision;
      const repoData = await api<Repo>("/api/repo");
      if (signal.aborted) return;
      const [commitData, treeData, statusData, commitView] = await Promise.all([
        api<{ commits: Commit[]; hasMore: boolean; total: number }>(
          `/api/commits?revision=${encodeURIComponent(location.revision)}&offset=0&limit=50`,
        ),
        api<{ entries: TreeEntry[]; revision: string }>(
          `/api/tree?revision=${encodeURIComponent(requestRevision)}&path=`,
        ),
        loadStatus(signal),
        location.commit ? loadCommitView(location.commit, signal) : null,
      ]);
      const local = !repoData.bare && isHeadRevision(requestRevision, repoData);
      let entry: TreeEntry | null = null;
      let file: FileView | null = null;
      let diff: DiffView | null = null;
      let label = "Select a file";
      let selected: string | null = null;
      if (location.view?.kind === "file") {
        entry = await findFileEntry(
          location.view.path,
          treeData.entries,
          requestRevision,
          local ? localFilePaths(statusData) : [],
          signal,
        );
        file = await loadFile(entry, requestRevision, statusData, local, signal);
        label = entry.path;
      } else if (location.view?.kind === "diff") {
        const { source, path } = location.view;
        diff =
          path === undefined && commitView
            ? commitView.diff
            : await api<DiffView>(
                `/api/diff?source=${source}&revision=${encodeURIComponent(requestRevision)}&path=${encodeURIComponent(path!)}`,
                signal,
              );
        label =
          path ??
          `${commitData.commits.find((commit) => commit.id === location.commit)?.shortId ?? location.commit!.slice(0, 7)} changes`;
        selected = path === undefined ? null : `${source}:${path}`;
      }
      if (signal.aborted) return;
      setRepo(repoData);
      setCommits(commitData.commits);
      setCommitTotal(commitData.total);
      setHasMore(commitData.hasMore);
      setTree(treeData.entries);
      setSearchQuery(null);
      setStatus(statusData);
      setRevision(requestRevision);
      setHistoryRevision(location.revision);
      setHistoryPages(1);
      setSelectedBranchRevision(
        location.revision === "HEAD"
          ? (repoData.branches.find((branch) => branch.name === repoData.head)?.revision ?? "HEAD")
          : location.revision,
      );
      setSelectedCommit(location.commit);
      setCommitChanges(commitView?.changes ?? []);
      setSelectedChange(selected);
      setFileEntry(entry);
      setFileView(file);
      setDiffView(diff);
      setFocusLine(undefined);
      setViewLabel(label);
    } catch (reason) {
      if (!signal.aborted) {
        setRepo(null);
        setError(reason instanceof Error ? reason.message : "Could not load the repository.");
      }
    } finally {
      if (!signal.aborted) {
        workspaceRequest.current = null;
        setLoading(false);
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    const restore = () => void loadWorkspace();
    restore();
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      navigationVersion.current++;
      workspaceRequest.current?.abort();
      previewRequest.current?.abort();
    };
  }, [loadWorkspace]);

  useEffect(() => {
    if (repo) document.title = `${repo.name} | gitto`;
  }, [repo]);

  const ready = Boolean(repo) && !loading && !busy && !previewLoading;
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
          const local = !repoData.bare && isHeadRevision(revision, repoData);
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
              api<{ commits: Commit[]; hasMore: boolean; total: number }>(
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
        setCommitTotal(pages[0].total);
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

  function cancelPreview() {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreviewLoading(false);
  }

  function startPreview() {
    cancelPreview();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewLoading(true);
    setError(null);
    return controller.signal;
  }

  async function chooseCommit(commit: Commit) {
    cancelPreview();
    const requestVersion = ++navigationVersion.current;
    setBusy(true);
    setError(null);
    try {
      const [treeData, commitView] = await Promise.all([
        api<{ entries: TreeEntry[] }>(`/api/tree?revision=${encodeURIComponent(commit.id)}&path=`),
        loadCommitView(commit.id),
      ]);
      if (requestVersion !== navigationVersion.current) return;
      setTree(treeData.entries);
      setFileView(null);
      setSearchQuery(null);
      setDiffView(commitView.diff);
      setSelectedChange(null);
      setRevision(commit.id);
      setSelectedCommit(commit.id);
      setCommitChanges(commitView.changes);
      setViewLabel(`${commit.shortId} changes`);
      writeViewLocation({
        revision: historyRevision,
        commit: commit.id,
        view: { kind: "diff", source: "commit" },
      });
    } catch (reason) {
      if (requestVersion === navigationVersion.current) {
        setError(reason instanceof Error ? reason.message : "Could not load the commit.");
      }
    } finally {
      if (requestVersion === navigationVersion.current) setBusy(false);
    }
  }

  async function chooseRevision(requestedRevision: string) {
    const nextRevision = isHeadRevision(requestedRevision, repo) ? "HEAD" : requestedRevision;
    cancelPreview();
    const requestVersion = ++navigationVersion.current;
    setBusy(true);
    setError(null);
    try {
      const [commitData, treeData] = await Promise.all([
        api<{ commits: Commit[]; hasMore: boolean; total: number }>(
          `/api/commits?revision=${encodeURIComponent(nextRevision)}&offset=0&limit=50`,
        ),
        api<{ entries: TreeEntry[] }>(
          `/api/tree?revision=${encodeURIComponent(nextRevision)}&path=`,
        ),
      ]);
      if (requestVersion !== navigationVersion.current) return;
      setCommits(commitData.commits);
      setCommitTotal(commitData.total);
      setHasMore(commitData.hasMore);
      setTree(treeData.entries);
      setRevision(nextRevision);
      setSearchQuery(null);
      setHistoryRevision(nextRevision);
      setHistoryPages(1);
      setSelectedBranchRevision(
        nextRevision === "HEAD"
          ? (repo?.branches.find((branch) => branch.name === repo.head)?.revision ?? "HEAD")
          : nextRevision,
      );
      setSelectedCommit(null);
      setCommitChanges([]);
      setSelectedChange(null);
      setFileView(null);
      setDiffView(null);
      setViewLabel("Select a file");
      writeViewLocation({ revision: nextRevision, commit: null, view: null });
    } catch (reason) {
      if (requestVersion === navigationVersion.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : nextRevision === "HEAD"
              ? "Could not load HEAD."
              : "Could not load the branch.",
        );
      }
    } finally {
      if (requestVersion === navigationVersion.current) setBusy(false);
    }
  }

  async function openEntry(entry: TreeEntry, line?: number) {
    const signal = startPreview();
    try {
      const data = await loadFile(entry, revision, status, viewingHead && !repo?.bare, signal);
      if (signal.aborted) return;
      setFileView(data);
      setFocusLine(line);
      setSearchQuery(null);
      setDiffView(null);
      setSelectedChange(null);
      setFileEntry(entry);
      setViewLabel(entry.path);
      writeViewLocation({
        revision: historyRevision,
        commit: selectedCommit,
        view: { kind: "file", path: entry.path },
      });
    } catch (reason) {
      if (!signal.aborted) {
        setError(reason instanceof Error ? reason.message : "Could not load the file.");
      }
    } finally {
      if (!signal.aborted) {
        previewRequest.current = null;
        setPreviewLoading(false);
      }
    }
  }

  async function openChange(source: ChangeSource, entry: StatusEntry) {
    const signal = startPreview();
    try {
      const data = await api<DiffView>(
        `/api/diff?source=${source}&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
        signal,
      );
      if (signal.aborted) return;
      setDiffView(data);
      setSearchQuery(null);
      setFileView(null);
      setSelectedChange(changeKey({ ...entry, source }));
      setViewLabel(entry.path);
      writeViewLocation({
        revision: historyRevision,
        commit: selectedCommit,
        view: { kind: "diff", source, path: entry.path },
      });
    } catch (reason) {
      if (!signal.aborted) {
        setError(reason instanceof Error ? reason.message : "Could not load the diff.");
      }
    } finally {
      if (!signal.aborted) {
        previewRequest.current = null;
        setPreviewLoading(false);
      }
    }
  }

  async function loadMore() {
    const requestVersion = ++navigationVersion.current;
    setBusy(true);
    try {
      const data = await api<{ commits: Commit[]; hasMore: boolean; total: number }>(
        `/api/commits?revision=${encodeURIComponent(historyRevision)}&offset=${commits.length}&limit=50`,
      );
      if (requestVersion !== navigationVersion.current) return;
      setCommits((current) => [...current, ...data.commits]);
      setCommitTotal(data.total);
      setHistoryPages(Math.ceil((commits.length + data.commits.length) / 50));
      setHasMore(data.hasMore);
    } catch (reason) {
      if (requestVersion === navigationVersion.current) {
        setError(reason instanceof Error ? reason.message : "Could not load history.");
      }
    } finally {
      if (requestVersion === navigationVersion.current) setBusy(false);
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
        stats: group.entries.reduce(
          (total, entry) => ({
            additions: total.additions + entry.stats!.additions,
            deletions: total.deletions + entry.stats!.deletions,
          }),
          { additions: 0, deletions: 0 },
        ),
        nodes: buildChangeTree(group.entries),
        decorations: buildChangeDecorations(group.entries),
      }));
  }, [status, selectedCommit, commitChanges]);
  const fileDecorations = useMemo(
    () => buildChangeDecorations(Object.values(status).flat()),
    [status],
  );
  const localPaths = viewingHead ? localFilePaths(status) : [];
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
  const hasView = Boolean(fileView || diffView || searchQuery !== null);

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
                  void chooseRevision("HEAD");
                  return;
                }
                const branch = repo?.branches.find((item) => item.revision === event.target.value);
                if (branch) void chooseRevision(branch.revision);
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
            <RepositoryCloseButton />
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
                revealPath={fileView?.path ?? (selectedChange ? viewLabel : undefined)}
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
        <section
          className="viewer-column"
          aria-label="Repository content"
          aria-busy={busy || previewLoading}
        >
          <header className="viewer-heading">
            {hasView && (
              <>
                {fileView && fileEntry && <EntryIcon name={viewLabel} kind={fileEntry.kind} />}
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
                    cancelPreview();
                    setSearchQuery(null);
                    setFileView(null);
                    setDiffView(null);
                    setSelectedChange(null);
                    setViewLabel("Select a file");
                    writeViewLocation({
                      revision: historyRevision,
                      commit: selectedCommit,
                      view: null,
                    });
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
            <button
              className="icon-button viewer-search-toggle"
              aria-label="Search"
              title="Search repository"
              aria-expanded={searchOpen}
              aria-controls="repository-search"
              disabled={busy}
              onClick={() => setSearchOpen((open) => !open)}
            >
              <svg
                className="ui-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m16 16 5 5" />
              </svg>
            </button>
          </header>
          <form
            id="repository-search"
            className="repository-search"
            role="search"
            hidden={!searchOpen}
            onSubmit={(event) => {
              event.preventDefault();
              cancelPreview();
              setFileView(null);
              setDiffView(null);
              setSelectedChange(null);
              setViewLabel("Search results");
              setSearchResult(null);
              setSearchError(null);
              setSearchQuery(searchInput.current!.value);
              setSearchVersion((version) => version + 1);
              writeViewLocation({ revision: historyRevision, commit: selectedCommit, view: null });
            }}
          >
            <input
              ref={searchInput}
              type="search"
              aria-label="Search repository"
              placeholder="Search repository · press Enter"
              disabled={busy}
              required
            />
          </form>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="pane-scroll viewer-content">
            {searchQuery !== null ? (
              searchError ? (
                <div className="inline-error" role="alert">
                  {searchError}
                </div>
              ) : searchResult ? (
                <SearchResults
                  result={searchResult}
                  query={searchQuery}
                  disabled={busy || previewLoading}
                  onOpen={(path, line) =>
                    void openEntry(
                      {
                        name: path.slice(path.lastIndexOf("/") + 1),
                        path,
                        kind: "blob",
                        size: null,
                      },
                      line,
                    )
                  }
                />
              ) : (
                <div className="viewer-loading" role="status">
                  Searching…
                </div>
              )
            ) : diffView ? (
              <DiffViewer view={diffView} />
            ) : fileView ? (
              <FileViewer file={fileView} focusLine={focusLine} />
            ) : busy || previewLoading ? (
              <div className="viewer-loading">Loading…</div>
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
                  <summary>
                    {group.label}
                    <span className="change-stats">
                      <span className="diff-add">+ {group.stats.additions}</span>
                      <span className="diff-del">− {group.stats.deletions}</span>
                    </span>
                  </summary>
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
            {selectedCommit && (
              <button
                className="back-to-head"
                onClick={() => void chooseRevision("HEAD")}
                disabled={busy}
              >
                Back to HEAD
              </button>
            )}
            <span>{commitTotal}</span>
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
                      {formatDateTime(commit.time)}
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
      <footer className="repo-footer" aria-label="Repository information">
        <span className="footer-meta">
          <span className="repo-path" title={repo?.path}>
            {repo?.path}
          </span>
          <span className="footer-separator" aria-hidden="true">
            |
          </span>
          <span className="repo-revision" title={selectedCommit ?? commits[0]?.id}>
            {selectedCommit
              ? `Commit ${selectedCommit.slice(0, 8)}`
              : revision === "HEAD"
                ? `HEAD${commits[0] ? ` · ${commits[0].shortId}` : " (unborn)"}`
                : commits[0]?.shortId}
          </span>
          {fileView && (
            <>
              <span className="footer-separator" aria-hidden="true">
                |
              </span>
              <span className="repo-size">{formatBytes(fileView.size)}</span>
            </>
          )}
        </span>
        <span className="footer-brand">
          <a href="https://github.com/ph0ryn/gitto" target="_blank" rel="noreferrer">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
            </svg>
            <strong>Gitto</strong>
          </a>
          <span>A read-only local Git browser</span>
          <span>v{repo?.appVersion}</span>
        </span>
      </footer>
    </main>
  );
}

function FileViewer({ file, focusLine }: { file: FileView; focusLine?: number }) {
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
        detail={`The file (${formatBytes(file.size)}) exceeds the 2 MiB preview limit.`}
      />
    );
  if (file.kind === "submodule")
    return (
      <EmptyState title="Submodule" detail="Submodule contents belong to a separate repository." />
    );
  if (file.content === null) throw new Error("Text content is missing.");
  return (
    <>
      {(file.removed || file.changesTruncated || file.size > MAX_HIGHLIGHT_BYTES) && (
        <div className="diff-summary">
          {file.removed && <span>Removed from working tree</span>}
          {file.changesTruncated && (
            <span className="diff-truncated">Change markers truncated</span>
          )}
          {file.size > MAX_HIGHLIGHT_BYTES && <span>Syntax highlighting disabled</span>}
        </div>
      )}
      <CodeViewer
        content={file.content}
        path={file.path}
        changes={file.changes}
        focusLine={focusLine}
      />
    </>
  );
}
