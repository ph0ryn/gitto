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
  const selectedBranch = repo?.branches.find((branch) => branch.revision === revision);
  const activeBranch = repo?.branches.find((branch) => branch.revision === selectedBranchRevision);
  const revisionLabel = selectedCommit
    ? `コミット ${selectedCommit.slice(0, 8)}`
    : (activeBranch?.name ??
      selectedBranch?.name ??
      (revision === "HEAD"
        ? repo?.head
          ? `HEAD ${repo.head.slice(0, 8)}`
          : "HEAD未作成"
        : `revision ${revision.slice(0, 8)}`));

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

  return (
    <div className="app-shell">
      <header className="repo-header">
        <div className="repo-title">
          <span className="brand-mark" aria-hidden="true">
            g
          </span>
          <div>
            <p className="eyebrow">LOCAL REPOSITORY</p>
            <h1>{repo?.name ?? "gitto"}</h1>
          </div>
        </div>
        <div className="repo-actions">
          <label className="branch-picker">
            <span>ブランチ</span>
            <select
              value={selectedBranchRevision}
              onChange={(event) => {
                if (event.target.value === "HEAD") {
                  void chooseHead();
                  return;
                }
                const branch = repo?.branches.find((item) => item.revision === event.target.value);
                if (branch) void chooseBranch(branch);
              }}
              disabled={!repo?.branches.length || busy}
            >
              {showHeadOption && <option value="HEAD">HEAD</option>}
              {repo?.branches.length ? (
                repo.branches.map((branch) => (
                  <option key={branch.revision} value={branch.revision}>
                    {branch.name}
                  </option>
                ))
              ) : (
                <option>ブランチなし</option>
              )}
            </select>
          </label>
          <button className="refresh-button" onClick={() => void loadWorkspace()} disabled={busy}>
            {busy ? "更新中…" : "更新"}
          </button>
        </div>
      </header>

      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}

      <main className="workspace">
        <aside className="history-column" aria-label="コミット履歴">
          <div className="column-heading">
            <h2>履歴</h2>
            <span>{commits.length}</span>
          </div>
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
        </aside>

        <aside className="changes-column" aria-label="変更されたファイル">
          <div className="column-heading">
            <h2>変更</h2>
            <span>{Object.values(status).reduce((sum, entries) => sum + entries.length, 0)}</span>
          </div>
          {repo?.bare ? (
            <p className="change-empty bare-note">作業ツリーなし</p>
          ) : (
            changeGroups.map((group) => {
              const entries = status[group.key];
              return (
                <section key={group.key} className="change-group">
                  <h3>
                    {group.label}
                    <span>{entries.length}</span>
                  </h3>
                  {entries.length === 0 ? (
                    <p className="change-empty">なし</p>
                  ) : (
                    entries.map((entry) => (
                      <div className="change-row" key={`${group.key}-${entry.path}`}>
                        <button
                          className="change-diff-button"
                          onClick={() => void openChange(group.source, entry)}
                          disabled={busy}
                          title={`${entry.path} の差分`}
                        >
                          <span className="status-dot" data-status={entry.status} />
                          <span title={entry.path}>{entry.path}</span>
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
                    ))
                  )}
                </section>
              );
            })
          )}
        </aside>

        <section className="browser-panel" aria-label="リポジトリ内容">
          <div className="browser-toolbar">
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
            <span className="revision-label">{revisionLabel}</span>
          </div>
          <div className="browser-content">
            <div className="tree-pane">
              <div className="pane-title">
                <h2>ファイル</h2>
                <span>{currentPath || "/"}</span>
              </div>
              {sortedTree.length === 0 ? (
                <EmptyState
                  title="ファイルはありません"
                  detail="このリビジョンには表示できるファイルがありません。"
                />
              ) : (
                <div className="tree-list">
                  {sortedTree.map((entry) => (
                    <button
                      className="tree-row"
                      key={entry.path}
                      onClick={() => void openEntry(entry)}
                      disabled={busy}
                      title={`${kindLabel(entry.kind)}: ${entry.path}`}
                    >
                      <EntryIcon kind={entry.kind} />
                      <span>{entry.name}</span>
                      <small>
                        {entry.kind === "blob" ? formatBytes(entry.size) : kindLabel(entry.kind)}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="viewer-pane">
              <div className="pane-title">
                <h2>{viewLabel}</h2>
                {fileView && <span>{formatBytes(fileView.size)}</span>}
              </div>
              {busy ? (
                <div className="viewer-loading">読み込み中…</div>
              ) : diffView ? (
                <DiffViewer view={diffView} />
              ) : fileView ? (
                <FileViewer file={fileView} />
              ) : (
                <EmptyState
                  title="閲覧する項目を選択"
                  detail="左のファイルツリー、履歴、変更一覧から選択してください。"
                />
              )}
            </div>
          </div>
        </section>
      </main>
      <footer className="app-footer">
        <span>gitto</span>
        <span>読み取り専用</span>
        <span>{repo?.path}</span>
      </footer>
    </div>
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
