import { useCallback, useEffect, useMemo, useState } from "react";

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
type TreeEntry = {
  name: string;
  path: string;
  kind: "tree" | "blob" | "symlink" | "submodule";
  size: number | null;
};
type StatusEntry = { path: string; oldPath: string | null; status: string };
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
};
type DiffFile = {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
};
type DiffView = { patch: string; files: DiffFile[]; truncated: boolean };
type ChangeSource = "staged" | "unstaged" | "untracked" | "commit";
type WorkingFileSource = "index" | "worktree";

const EMPTY_STATUS: Status = {
  staged: [],
  unstaged: [],
  untracked: [],
  conflicts: [],
};

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function formatDate(seconds: number) {
  return new Intl.DateTimeFormat("ja-JP", {
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

function kindLabel(kind: TreeEntry["kind"]) {
  if (kind === "tree") return "フォルダー";
  if (kind === "symlink") return "シンボリックリンク";
  if (kind === "submodule") return "サブモジュール";
  return "ファイル";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    added: "追加",
    modified: "変更",
    deleted: "削除",
    renamed: "名前変更",
    typechange: "種類変更",
    untracked: "未追跡",
    conflicted: "競合",
  };
  return labels[status] ?? status;
}

function EntryIcon({ kind }: { kind: TreeEntry["kind"] }) {
  return <span aria-hidden="true" className={`entry-icon entry-icon-${kind}`} />;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true" />
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
  const [selectedBranchRevision, setSelectedBranchRevision] = useState("");
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [viewLabel, setViewLabel] = useState("ファイルを選択してください");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
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
        api<Status>("/api/status"),
      ]);
      setRepo(repoData);
      setCommits(commitData.commits);
      setHasMore(commitData.hasMore);
      setTree(treeData.entries);
      setStatus(statusData);
      setRevision(requestRevision);
      setSelectedBranchRevision(
        repoData.branches.find((branch) => branch.name === repoData.head)?.revision ?? "HEAD",
      );
      setSelectedCommit(null);
      setCurrentPath("");
      setFileView(null);
      setDiffView(null);
      setViewLabel("ファイルを選択してください");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "リポジトリを読み込めませんでした");
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

  const sortedTree = useMemo(
    () =>
      [...tree].sort(
        (a, b) =>
          Number(b.kind === "tree") - Number(a.kind === "tree") || a.name.localeCompare(b.name),
      ),
    [tree],
  );

  async function chooseCommit(commit: Commit) {
    setBusy(true);
    setError(null);
    setFileView(null);
    setDiffView(null);
    setViewLabel("読み込み中…");
    try {
      const [treeData, diffData] = await Promise.all([
        api<{ entries: TreeEntry[] }>(`/api/tree?revision=${encodeURIComponent(commit.id)}&path=`),
        api<DiffView>(`/api/diff?source=commit&revision=${encodeURIComponent(commit.id)}`),
      ]);
      setTree(treeData.entries);
      setDiffView(diffData);
      setRevision(commit.id);
      setSelectedCommit(commit.id);
      setCurrentPath("");
      setViewLabel(`${commit.shortId} の変更`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "コミットを読み込めませんでした");
      setViewLabel("ファイルを選択してください");
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
    setViewLabel("読み込み中…");
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
      setSelectedBranchRevision(branch.revision);
      setSelectedCommit(null);
      setCurrentPath("");
      setFileView(null);
      setDiffView(null);
      setViewLabel("ファイルを選択してください");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ブランチを読み込めませんでした");
      setViewLabel("ファイルを選択してください");
    } finally {
      setBusy(false);
    }
  }

  async function chooseHead() {
    setBusy(true);
    setError(null);
    setFileView(null);
    setDiffView(null);
    setViewLabel("読み込み中…");
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
      setSelectedBranchRevision("HEAD");
      setSelectedCommit(null);
      setCurrentPath("");
      setViewLabel("ファイルを選択してください");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "HEADを読み込めませんでした");
      setViewLabel("ファイルを選択してください");
    } finally {
      setBusy(false);
    }
  }

  async function openEntry(entry: TreeEntry) {
    setBusy(true);
    setError(null);
    setDiffView(null);
    setFileView(null);
    setViewLabel("読み込み中…");
    if (entry.kind === "tree") setTree([]);
    try {
      if (entry.kind === "tree") {
        const data = await api<{ entries: TreeEntry[] }>(
          `/api/tree?revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
        );
        setTree(data.entries);
        setCurrentPath(entry.path);
        setViewLabel(entry.path);
      } else {
        const data = await api<FileView>(
          `/api/file?source=commit&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
        );
        setFileView(data);
        setViewLabel(entry.path);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ファイルを読み込めませんでした");
      setViewLabel("ファイルを選択してください");
    } finally {
      setBusy(false);
    }
  }

  async function openChange(source: ChangeSource, entry: StatusEntry) {
    setBusy(true);
    setError(null);
    setFileView(null);
    setDiffView(null);
    setViewLabel("読み込み中…");
    try {
      const data = await api<DiffView>(
        `/api/diff?source=${source}&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
      );
      setDiffView(data);
      setViewLabel(entry.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "差分を読み込めませんでした");
      setViewLabel("ファイルを選択してください");
    } finally {
      setBusy(false);
    }
  }

  async function openWorkingFile(source: WorkingFileSource, entry: StatusEntry) {
    setBusy(true);
    setError(null);
    setFileView(null);
    setDiffView(null);
    setViewLabel("読み込み中…");
    try {
      const data = await api<FileView>(
        `/api/file?source=${source}&revision=HEAD&path=${encodeURIComponent(entry.path)}`,
      );
      setFileView(data);
      setViewLabel(entry.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ファイルを読み込めませんでした");
      setViewLabel("ファイルを選択してください");
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus() {
    setRefreshingStatus(true);
    setError(null);
    try {
      setStatus(await api<Status>("/api/status"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "変更を読み込めませんでした");
    } finally {
      setRefreshingStatus(false);
    }
  }

  async function loadMore() {
    setBusy(true);
    try {
      const data = await api<{ commits: Commit[]; hasMore: boolean }>(
        `/api/commits?revision=${encodeURIComponent(selectedBranchRevision || "HEAD")}&offset=${commits.length}&limit=50`,
      );
      setCommits((current) => [...current, ...data.commits]);
      setHasMore(data.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "履歴を読み込めませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function goToPath(path: string) {
    setBusy(true);
    setError(null);
    setFileView(null);
    setDiffView(null);
    setTree([]);
    setViewLabel("読み込み中…");
    try {
      const data = await api<{ entries: TreeEntry[] }>(
        `/api/tree?revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(path)}`,
      );
      setTree(data.entries);
      setCurrentPath(path);
      setViewLabel("ファイルを選択してください");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "フォルダーを読み込めませんでした");
      setViewLabel("ファイルを選択してください");
    } finally {
      setBusy(false);
    }
  }

  const breadcrumbs = currentPath ? currentPath.split("/") : [];
  const changeGroups: {
    label: string;
    key: keyof Status;
    source: ChangeSource;
    fileSource: WorkingFileSource;
  }[] = [
    { label: "Staged", key: "staged", source: "staged", fileSource: "index" },
    { label: "Unstaged", key: "unstaged", source: "unstaged", fileSource: "worktree" },
    { label: "Untracked", key: "untracked", source: "untracked", fileSource: "worktree" },
    {
      label: "Conflicts（ours → 作業ツリー）",
      key: "conflicts",
      source: "unstaged",
      fileSource: "worktree",
    },
  ];
  const showHeadOption = Boolean(
    repo && (!repo.head || !repo.branches.some((branch) => branch.name === repo.head)),
  );

  if (loading) {
    return (
      <div className="app-state">
        <div className="loading-block" />
        <p>リポジトリを読み込んでいます…</p>
      </div>
    );
  }

  if (error && !repo) {
    return (
      <div className="app-state error-state">
        <strong>読み込みに失敗しました</strong>
        <p>{error}</p>
        <button onClick={() => void loadWorkspace()}>再試行</button>
      </div>
    );
  }

  const changeCount = Object.values(status).reduce((sum, entries) => sum + entries.length, 0);
  const hasView = Boolean(fileView || diffView);

  return (
    <main className="app-shell">
      <div className="workspace">
        <aside className="files-column" aria-label="ファイルツリー">
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
              aria-label="ブランチ"
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
                <option value={selectedCommit}>コミット {selectedCommit.slice(0, 8)}</option>
              )}
              {showHeadOption && <option value="HEAD">HEAD</option>}
              {repo?.branches.length
                ? repo.branches.map((branch) => (
                    <option key={branch.revision} value={branch.revision}>
                      {branch.name}
                    </option>
                  ))
                : !showHeadOption && <option value="HEAD">ブランチなし</option>}
            </select>
          </div>
          <div className="pane-toolbar">
            <h2>ファイル</h2>
            <span>{sortedTree.length}</span>
          </div>
          <nav className="breadcrumbs" aria-label="パス">
            <button onClick={() => void goToPath("")} disabled={busy}>
              ルート
            </button>
            {breadcrumbs.map((part, index) => {
              const path = breadcrumbs.slice(0, index + 1).join("/");
              return (
                <span key={path}>
                  <i>/</i>
                  <button onClick={() => void goToPath(path)} disabled={busy}>
                    {part}
                  </button>
                </span>
              );
            })}
          </nav>
          <div className="pane-scroll tree-content">
            {sortedTree.length === 0 ? (
              <EmptyState
                title="ファイルはありません"
                detail="このリビジョンには表示できるファイルがありません。"
              />
            ) : (
              <div className="tree-list">
                {sortedTree.map((entry) => (
                  <button
                    className={fileView?.path === entry.path ? "tree-row is-selected" : "tree-row"}
                    key={entry.path}
                    onClick={() => void openEntry(entry)}
                    disabled={busy}
                    title={`${kindLabel(entry.kind)}: ${entry.path}`}
                  >
                    <EntryIcon kind={entry.kind} />
                    <span>{entry.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
        <section className="viewer-column" aria-label="リポジトリ内容" aria-busy={busy}>
          <div className="viewer-tabs">
            {hasView && (
              <div className="viewer-tab is-active">
                {fileView && <EntryIcon kind="blob" />}
                <h2 title={viewLabel}>{viewLabel.slice(viewLabel.lastIndexOf("/") + 1)}</h2>
                {hasView && (
                  <button
                    className="icon-button close-button"
                    aria-label="表示を閉じる"
                    title="表示を閉じる"
                    disabled={busy}
                    onClick={() => {
                      setFileView(null);
                      setDiffView(null);
                      setViewLabel("ファイルを選択してください");
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
                )}
              </div>
            )}
          </div>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="pane-scroll viewer-content">
            {busy ? (
              <div className="viewer-loading">読み込み中…</div>
            ) : diffView ? (
              <DiffViewer view={diffView} />
            ) : fileView ? (
              <FileViewer file={fileView} />
            ) : (
              <EmptyState
                title="ファイルを開く"
                detail="左のツリーからファイルを選択してください。右の変更やコミットから差分も確認できます。"
              />
            )}
          </div>
        </section>
        <aside
          className="changes-column"
          aria-label="変更されたファイル"
          aria-busy={refreshingStatus}
        >
          <div className="column-heading">
            <h2>変更</h2>
            <div className="heading-actions">
              <span>{changeCount}</span>
              <button
                className="icon-button"
                onClick={() => void refreshStatus()}
                disabled={busy || refreshingStatus}
                aria-label="更新"
                title={refreshingStatus ? "変更を更新中…" : "変更を更新"}
              >
                <svg
                  className="ui-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9" />
                </svg>
              </button>
            </div>
          </div>
          <div className="pane-scroll changes-list">
            {repo?.bare ? (
              <EmptyState title="作業ツリーなし" detail="コミット済みのファイルを閲覧できます。" />
            ) : changeCount === 0 ? (
              <EmptyState title="変更はありません" detail="作業ツリーはクリーンです。" />
            ) : (
              changeGroups
                .filter((group) => status[group.key].length > 0)
                .map((group) => {
                  const entries = status[group.key];
                  return (
                    <section key={group.key} className="change-group">
                      <h3>
                        {group.label}
                        <span>{entries.length}</span>
                      </h3>
                      {entries.map((entry) => (
                        <div className="change-row" key={`${group.key}-${entry.path}`}>
                          <button
                            className="change-diff-button"
                            onClick={() => void openChange(group.source, entry)}
                            disabled={busy}
                            title={`${entry.path} の差分`}
                            aria-label={`${entry.path} の差分（${statusLabel(entry.status)}）`}
                          >
                            <span className="status-dot" data-status={entry.status} />
                            <span className="change-name" title={entry.path}>
                              <span>{entry.path.slice(entry.path.lastIndexOf("/") + 1)}</span>
                              {entry.path.includes("/") && (
                                <small>{entry.path.slice(0, entry.path.lastIndexOf("/"))}</small>
                              )}
                            </span>
                            <small>{statusLabel(entry.status)}</small>
                          </button>
                          <button
                            className="change-content-button"
                            onClick={() => void openWorkingFile(group.fileSource, entry)}
                            disabled={busy || entry.status === "deleted"}
                            title={
                              entry.status === "deleted"
                                ? "削除されたファイルの内容は表示できません"
                                : `${entry.path} の内容`
                            }
                          >
                            内容
                          </button>
                        </div>
                      ))}
                    </section>
                  );
                })
            )}
          </div>
        </aside>

        <aside className="history-column" aria-label="コミット履歴">
          <div className="column-heading">
            <h2>コミット</h2>
            <span>{commits.length}</span>
          </div>
          <div className="pane-scroll history-content">
            {commits.length === 0 ? (
              <EmptyState title="コミットはありません" detail="HEADがまだ作成されていません。" />
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
                      <strong>{commit.summary || "（メッセージなし）"}</strong>
                      <small>
                        {commit.shortId} · {commit.author}
                      </small>
                    </span>
                    <time dateTime={new Date(commit.time * 1000).toISOString()}>
                      {formatDate(commit.time)}
                    </time>
                  </button>
                ))}
                {hasMore && (
                  <button className="load-more" onClick={() => void loadMore()} disabled={busy}>
                    もっと読む
                  </button>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
      <footer className="repo-footer" aria-label="リポジトリのパス">
        <span className="repo-path" title={repo?.path}>
          {repo?.path}
        </span>
        <span className="footer-meta">
          {fileView && <span>{formatBytes(fileView.size)}</span>}
          <span title={selectedCommit ?? commits[0]?.id}>
            {selectedCommit
              ? `コミット ${selectedCommit.slice(0, 8)}`
              : revision === "HEAD"
                ? `HEAD${commits[0] ? ` · ${commits[0].shortId}` : "（未作成）"}`
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
        title="バイナリファイル"
        detail={`${formatBytes(file.size)} のバイナリは表示できません。`}
      />
    );
  if (file.kind === "tooLarge")
    return (
      <EmptyState
        title="ファイルが大きすぎます"
        detail={`${formatBytes(file.size)} のため内容を表示できません。`}
      />
    );
  if (file.kind === "submodule")
    return (
      <EmptyState
        title="サブモジュール"
        detail="サブモジュールの内容は別のリポジトリにあります。"
      />
    );
  return (
    <pre className="code-view">
      <code>{file.content ?? ""}</code>
    </pre>
  );
}

function DiffViewer({ view }: { view: DiffView }) {
  const specialFiles = view.files.filter(
    (file) =>
      file.binary || file.status.includes("submodule") || file.status.includes("conflicted"),
  );
  return (
    <div className="diff-view">
      <div className="diff-summary">
        {view.files.length} ファイル{" "}
        <span className="diff-add">
          +{view.files.reduce((sum, file) => sum + file.additions, 0)}
        </span>{" "}
        <span className="diff-del">
          −{view.files.reduce((sum, file) => sum + file.deletions, 0)}
        </span>
        {view.truncated && <span className="diff-truncated">一部省略</span>}
      </div>
      {specialFiles.length > 0 && (
        <ul className="diff-file-list">
          {specialFiles.map((file) => {
            const submodule = file.status.includes("submodule");
            const conflicted = file.status.includes("conflicted");
            return (
              <li key={file.path}>
                <span>{file.path}</span>
                <small>
                  {submodule
                    ? "サブモジュールの競合"
                    : conflicted
                      ? "競合（ours → 作業ツリー）"
                      : "バイナリ差分"}
                </small>
              </li>
            );
          })}
        </ul>
      )}
      <pre className="patch-view">
        <code>{view.patch || (specialFiles.length > 0 ? "" : "差分はありません。")}</code>
      </pre>
    </div>
  );
}
