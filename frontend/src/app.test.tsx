import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import App from "./app";
import type { TreeEntry } from "./fileTree";

const repo = {
  name: "sample-repo",
  path: "/tmp/sample-repo",
  head: "main",
  bare: false,
  branches: [{ name: "main", revision: "refs/heads/main" }],
};
type TestStatus = {
  staged: Array<{ path: string; oldPath: string | null; status: string }>;
  unstaged: Array<{ path: string; oldPath: string | null; status: string }>;
  untracked: Array<{ path: string; oldPath: string | null; status: string }>;
  conflicts: Array<{ path: string; oldPath: string | null; status: string }>;
};
const tree: { revision: string; entries: TreeEntry[] } = {
  revision: "HEAD",
  entries: [{ name: "README.md", path: "README.md", kind: "blob", size: 24 }],
};
const commits = {
  hasMore: false,
  commits: [
    {
      id: "abc123456789",
      shortId: "abc1234",
      summary: "最初のコミット",
      message: "最初のコミット",
      author: "Aki",
      time: 1720000000,
      parents: [],
    },
  ],
};
const status: TestStatus = {
  staged: [{ path: "src/main.ts", oldPath: null, status: "modified" }],
  unstaged: [],
  untracked: [],
  conflicts: [],
};

function response(data: unknown, statusCode = 200) {
  return Promise.resolve({
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    json: async () => data,
  }) as Promise<Response>;
}

function installFetch(
  options: {
    repoData?: typeof repo;
    statusData?: TestStatus;
    diffData?: unknown;
    commitStats?: unknown;
    diffPromise?: Promise<unknown>;
    trees?: Record<string, typeof tree.entries>;
    stats?: Record<string, { additions: number; deletions: number; binary?: boolean }>;
  } = {},
) {
  const repoData = options.repoData ?? repo;
  const statusData = options.statusData ?? status;
  const diffData = options.diffData ?? {
    patch: "@@ -1 +1 @@\n-old\n+new",
    files: [
      {
        path: "README.md",
        oldPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
      },
    ],
    truncated: false,
  };
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/repo") return response(repoData);
      if (url.startsWith("/api/commits")) return response(commits);
      if (url.startsWith("/api/tree")) {
        const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
        const entries = options.trees ? options.trees[path] : tree.entries;
        if (!entries) throw new Error(`unexpected tree path: ${path}`);
        return response({ ...tree, entries });
      }
      if (url === "/api/status") return response(statusData);
      if (url.startsWith("/api/file"))
        return response({
          path: new URL(url, "http://localhost").searchParams.get("path"),
          kind: "text",
          content: "# gitto\n",
          size: 7,
        });
      if (url.startsWith("/api/diff")) {
        const query = new URL(url, "http://localhost").searchParams;
        if (query.get("statsOnly") === "true") {
          const source = query.get("source");
          if (source === "commit") return response(options.commitStats ?? diffData);
          const entries =
            source === "staged"
              ? statusData.staged
              : [...statusData.unstaged, ...statusData.conflicts];
          return response({
            patch: "",
            truncated: false,
            files: entries.map((entry) => ({
              ...entry,
              additions: 1,
              deletions: 1,
              binary: false,
              ...options.stats?.[`${source}:${entry.path}`],
            })),
          });
        }
        if (options.diffPromise) await options.diffPromise;
        return response(diffData);
      }
      throw new Error(`unexpected request: ${url}`);
    });
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.title = "gitto";
});

describe("App", () => {
  it("opens an untracked directory that replaced a committed file", async () => {
    installFetch({
      trees: { "": [{ name: "notes", path: "notes", kind: "blob", size: 12 }] },
      statusData: {
        ...status,
        untracked: [{ path: "notes/new.md", oldPath: null, status: "untracked" }],
      },
    });
    const user = userEvent.setup();
    render(<App />);
    const files = await screen.findByRole("complementary", { name: "File tree" });
    const folder = within(files).getByRole("button", { name: "notes" });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    await user.click(folder);
    expect(await within(files).findByRole("button", { name: "new.md" })).toBeVisible();
  });

  it("shows untracked files in existing and new folders at HEAD and opens their working content", async () => {
    const fetchMock = installFetch({
      repoData: {
        ...repo,
        branches: [...repo.branches, { name: "other", revision: "refs/heads/other" }],
      },
      statusData: {
        ...status,
        untracked: [
          { path: "src/new.ts", oldPath: null, status: "untracked" },
          { path: "notes/deep/new.md", oldPath: null, status: "untracked" },
        ],
      },
      trees: {
        "": [{ name: "src", path: "src", kind: "tree", size: null }],
        src: [{ name: "main.ts", path: "src/main.ts", kind: "blob", size: 12 }],
      },
    });
    const user = userEvent.setup();
    render(<App />);
    const files = await screen.findByRole("complementary", { name: "File tree" });
    await user.click(within(files).getByRole("button", { name: "src" }));
    expect(await within(files).findByRole("button", { name: "new.ts" })).toHaveAttribute(
      "data-change",
      "untracked",
    );
    expect(within(files).getByRole("button", { name: "main.ts" })).toBeVisible();
    await user.click(within(files).getByRole("button", { name: "notes" }));
    await user.click(await within(files).findByRole("button", { name: "deep" }));
    await user.click(await within(files).findByRole("button", { name: "new.md" }));
    expect(await screen.findByText("# gitto")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/file?source=worktree&revision=HEAD&path=notes%2Fdeep%2Fnew.md",
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          typeof url === "string" && url.startsWith("/api/tree") && url.includes("path=notes"),
      ),
    ).toBe(false);
    await user.selectOptions(screen.getByLabelText("Branch"), "refs/heads/other");
    await waitFor(() =>
      expect(within(files).queryByRole("button", { name: "notes" })).not.toBeInTheDocument(),
    );
  });

  it("refreshes untracked files inside an expanded folder without collapsing it", async () => {
    const statusData: TestStatus = { ...status, untracked: [] };
    const fetchMock = installFetch({
      statusData,
      trees: {
        "": [{ name: "src", path: "src", kind: "tree", size: null }],
        src: [{ name: "main.ts", path: "src/main.ts", kind: "blob", size: 12 }],
      },
    });
    const user = userEvent.setup();
    render(<App />);
    const files = await screen.findByRole("complementary", { name: "File tree" });
    const folder = within(files).getByRole("button", { name: "src" });
    await user.click(folder);
    await within(files).findByRole("button", { name: "main.ts" });
    statusData.untracked = [{ path: "src/new.ts", oldPath: null, status: "untracked" }];
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await within(files).findByRole("button", { name: "new.ts" })).toBeVisible();
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/tree?revision=HEAD&path=src"),
    ).toHaveLength(1);
    statusData.staged = [
      ...statusData.staged,
      { path: "src/new.ts", oldPath: null, status: "added" },
    ];
    statusData.untracked = [];
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const added = await within(files).findByRole("button", { name: "new.ts" });
    expect(added).toHaveAttribute("data-change", "added");
    await user.click(added);
    await screen.findByText("# gitto");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/file?source=index&revision=HEAD&path=src%2Fnew.ts",
    );
  });

  it("decorates changed files and their parent folders only at the checked-out revision", async () => {
    installFetch({
      repoData: {
        ...repo,
        branches: [...repo.branches, { name: "other", revision: "refs/heads/other" }],
      },
      trees: {
        "": [{ name: "src", path: "src", kind: "tree", size: null }],
        src: [{ name: "main.ts", path: "src/main.ts", kind: "blob", size: 12 }],
      },
    });
    const user = userEvent.setup();
    render(<App />);
    const files = await screen.findByRole("complementary", { name: "File tree" });
    const folder = within(files).getByRole("button", { name: "src" });
    expect(folder).toHaveAttribute("data-change", "modified");
    await user.click(folder);
    expect(await within(files).findByRole("button", { name: "main.ts" })).toHaveAttribute(
      "data-change",
      "modified",
    );
    const changes = screen.getByRole("complementary", { name: "Changed files" });
    expect(
      within(changes).getByRole("button", { name: "src/main.ts diff (Staged · modified)" }),
    ).toHaveAttribute("data-change", "modified");
    await user.selectOptions(screen.getByLabelText("Branch"), "refs/heads/other");
    await waitFor(() =>
      expect(within(files).getByRole("button", { name: "src" })).not.toHaveAttribute("data-change"),
    );
  });

  it("expands folders in place and keeps the preview and cached children", async () => {
    const fetchMock = installFetch({
      trees: {
        "": [...tree.entries, { name: "frontend", path: "frontend", kind: "tree", size: null }],
        frontend: [{ name: "app.tsx", path: "frontend/app.tsx", kind: "blob", size: 12 }],
      },
    });
    const user = userEvent.setup();
    render(<App />);
    const files = await screen.findByRole("complementary", { name: "File tree" });
    await user.click(within(files).getByRole("button", { name: "README.md" }));
    const folder = within(files).getByRole("button", { name: "frontend" });
    await user.click(folder);

    const child = await within(files).findByRole("button", { name: "app.tsx" });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(within(files).getByRole("button", { name: "README.md" })).toBeVisible();
    expect(screen.getByText("# gitto")).toBeInTheDocument();
    await user.click(folder);
    expect(child).not.toBeVisible();
    await user.click(folder);
    expect(child).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/tree?revision=HEAD&path=frontend"),
    ).toHaveLength(1);
  });

  it("groups changes by folder, shows line counts, and removes content buttons", async () => {
    installFetch({
      statusData: {
        ...status,
        staged: [],
        unstaged: [
          { path: "frontend/src/app.test.tsx", oldPath: null, status: "modified" },
          { path: ".gitignore", oldPath: null, status: "modified" },
        ],
        untracked: [{ path: "notes/new.md", oldPath: null, status: "untracked" }],
      },
      stats: { "unstaged:frontend/src/app.test.tsx": { additions: 140, deletions: 6 } },
    });
    const user = userEvent.setup();
    render(<App />);
    const changes = await screen.findByRole("complementary", { name: "Changed files" });

    expect(within(changes).getByText("Tracked")).toBeInTheDocument();
    expect(within(changes).getByText("Untracked")).toBeInTheDocument();
    expect(within(changes).getByText("frontend/src")).toBeInTheDocument();
    expect(within(changes).getByText("+ 140")).toBeInTheDocument();
    expect(within(changes).getByText("− 6")).toBeInTheDocument();
    expect(within(changes).queryByRole("button", { name: "Content" })).not.toBeInTheDocument();
    await user.click(within(changes).getByText("frontend/src"));
    expect(within(changes).getByText("app.test.tsx")).not.toBeVisible();
    expect(within(changes).getByText(".gitignore")).toBeVisible();
  });

  it("keeps the file preview and root entries when a folder fails to load", async () => {
    const fetchMock = installFetch({
      trees: { "": [...tree.entries, { name: "src", path: "src", kind: "tree", size: null }] },
    });
    const user = userEvent.setup();
    render(<App />);
    const files = await screen.findByRole("complementary", { name: "File tree" });
    await user.click(within(files).getByRole("button", { name: "README.md" }));
    fetchMock.mockImplementationOnce(() => response({ error: "Folder unavailable" }, 500));
    const folder = within(files).getByRole("button", { name: "src" });
    await user.click(folder);

    expect(await screen.findByRole("alert")).toHaveTextContent("Folder unavailable");
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(within(files).getByRole("button", { name: "README.md" })).toBeVisible();
    expect(screen.getByText("# gitto")).toBeInTheDocument();
  });

  it("clears expanded folders when another branch is selected", async () => {
    installFetch({
      repoData: {
        ...repo,
        branches: [...repo.branches, { name: "other", revision: "refs/heads/other" }],
      },
      trees: {
        "": [...tree.entries, { name: "src", path: "src", kind: "tree", size: null }],
        src: [{ name: "main.ts", path: "src/main.ts", kind: "blob", size: 12 }],
      },
    });
    const user = userEvent.setup();
    render(<App />);
    const files = await screen.findByRole("complementary", { name: "File tree" });
    await user.click(within(files).getByRole("button", { name: "src" }));
    expect(await within(files).findByRole("button", { name: "main.ts" })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Branch"), "refs/heads/other");
    await waitFor(() =>
      expect(within(files).getByRole("button", { name: "src" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    expect(within(files).queryByRole("button", { name: "main.ts" })).not.toBeInTheDocument();
  });

  it("ignores a folder load failure after switching branches", async () => {
    const fetchMock = installFetch({
      repoData: {
        ...repo,
        branches: [...repo.branches, { name: "other", revision: "refs/heads/other" }],
      },
      trees: { "": [{ name: "src", path: "src", kind: "tree", size: null }] },
    });
    const user = userEvent.setup();
    render(<App />);
    const files = await screen.findByRole("complementary", { name: "File tree" });
    let rejectFolder!: (reason: Error) => void;
    const folderRequest = new Promise<Response>((_, reject) => {
      rejectFolder = reject;
    });
    fetchMock.mockImplementationOnce(() => folderRequest);
    await user.click(within(files).getByRole("button", { name: "src" }));
    await user.selectOptions(screen.getByLabelText("Branch"), "refs/heads/other");
    await waitFor(() =>
      expect(within(files).getByRole("button", { name: "src" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    await act(async () => {
      rejectFolder(new Error("Old folder unavailable"));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps separate staged and unstaged diff actions for the same path", async () => {
    const fetchMock = installFetch({
      statusData: { ...status, unstaged: [...status.staged] },
      stats: {
        "staged:src/main.ts": { additions: 4, deletions: 2 },
        "unstaged:src/main.ts": { additions: 8, deletions: 3 },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    const staged = await screen.findByRole("button", {
      name: "src/main.ts diff (Staged · modified)",
    });
    expect(within(staged).getByText("+ 4")).toBeInTheDocument();
    const unstaged = screen.getByRole("button", { name: "src/main.ts diff (Unstaged · modified)" });
    expect(within(unstaged).getByText("+ 8")).toBeInTheDocument();
    await user.click(staged);
    await waitFor(() => expect(staged).toHaveAttribute("aria-pressed", "true"));
    await user.click(unstaged);
    await waitFor(() => expect(unstaged).toHaveAttribute("aria-pressed", "true"));
    expect(staged).toHaveAttribute("aria-pressed", "false");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=staged&revision=HEAD&path=src%2Fmain.ts",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=unstaged&revision=HEAD&path=src%2Fmain.ts",
    );
  });

  it("keeps the preview when refreshed diff statistics fail", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "README.md" }));
    fetchMock.mockImplementationOnce(() => response(status));
    fetchMock.mockImplementationOnce(() => response({ error: "Statistics unavailable" }, 500));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Statistics unavailable");
    expect(screen.getByText("# gitto")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("uses the repository name in the page title", async () => {
    installFetch();
    render(<App />);

    await waitFor(() => expect(document.title).toBe("sample-repo | gitto"));
  });

  it("places files, content, changes, and history in the requested reading order", async () => {
    installFetch();
    render(<App />);

    const files = await screen.findByRole("complementary", { name: "File tree" });
    expect(within(files).getByLabelText("Branch")).toHaveValue("refs/heads/main");
    expect(screen.getAllByText("main")).toHaveLength(1);
    const content = screen.getByRole("region", { name: "Repository content" });
    expect(within(content).queryByRole("heading")).not.toBeInTheDocument();
    const changes = screen.getByRole("complementary", { name: "Changed files" });
    const history = screen.getByRole("complementary", { name: "Commit history" });
    const footer = screen.getByLabelText("Repository path");
    expect(within(footer).getByText("HEAD · abc1234")).toBeInTheDocument();
    for (const [left, right] of [
      [files, content],
      [content, changes],
      [changes, history],
      [history, footer],
    ]) {
      expect(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("closes the current file without changing the repository navigation", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /README\.md/ }));
    expect(await screen.findByText("# gitto")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close view" }));

    expect(screen.queryByText("# gitto")).not.toBeInTheDocument();
    expect(screen.getByText("Open a file")).toBeInTheDocument();
    expect(screen.getByLabelText("Branch")).toHaveValue("refs/heads/main");
    expect(screen.getByRole("button", { name: /README\.md/ })).toBeInTheDocument();
  });

  it("refreshes only changes while keeping the open file", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /README\.md/ }));
    expect(await screen.findByText("# gitto")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());

    expect(screen.getByText("# gitto")).toBeInTheDocument();
    expect(screen.getByLabelText("Branch")).toHaveValue("refs/heads/main");
    expect(
      within(screen.getByLabelText("Repository path")).getByText("HEAD · abc1234"),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/status")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/repo")).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => typeof url === "string" && url.startsWith("/api/tree"),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => typeof url === "string" && url.startsWith("/api/commits"),
      ),
    ).toHaveLength(1);
  });

  it("keeps the preview visible when refreshing changes fails", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /README\.md/ }));
    expect(await screen.findByText("# gitto")).toBeInTheDocument();
    fetchMock.mockImplementationOnce(() => response({ error: "status unavailable" }, 500));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("status unavailable");
    expect(screen.getByText("# gitto")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("shows parent directories for changed files with the same name", async () => {
    installFetch({
      statusData: {
        ...status,
        staged: [
          { path: "src/index.ts", oldPath: null, status: "modified" },
          { path: "lib/index.ts", oldPath: null, status: "modified" },
        ],
      },
    });
    render(<App />);

    const changes = await screen.findByRole("complementary", { name: "Changed files" });
    expect(within(changes).getByText("src")).toBeInTheDocument();
    expect(within(changes).getByText("lib")).toBeInTheDocument();
    expect(
      within(changes).getByRole("button", { name: "src/index.ts diff (Staged · modified)" }),
    ).toBeInTheDocument();
    expect(
      within(changes).getByRole("button", { name: "lib/index.ts diff (Staged · modified)" }),
    ).toBeInTheDocument();
  });

  it("uses HEAD for the initial view and selects the matching full branch ref", async () => {
    const fetchMock = installFetch();
    render(<App />);

    await screen.findByRole("complementary", { name: "File tree" });

    expect(fetchMock).toHaveBeenCalledWith("/api/commits?revision=HEAD&offset=0&limit=50");
    expect(fetchMock).toHaveBeenCalledWith("/api/tree?revision=HEAD&path=");
    expect(screen.getByLabelText("Branch")).toHaveValue("refs/heads/main");
  });

  it("keeps HEAD as an explicit choice for a detached or unborn repository", async () => {
    installFetch({
      repoData: {
        ...repo,
        head: "deadbee",
        branches: [{ name: "main", revision: "refs/heads/main" }],
      },
    });
    render(<App />);

    await screen.findByRole("complementary", { name: "File tree" });

    expect(screen.getByRole("option", { name: "HEAD" })).toBeInTheDocument();
    expect(screen.getByLabelText("Branch")).toHaveValue("HEAD");
  });

  it("displays repository, history, tree, and changes from the API", async () => {
    installFetch();
    render(<App />);

    expect(await screen.findByRole("complementary", { name: "File tree" })).toBeInTheDocument();
    expect(screen.getByText("最初のコミット")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByTitle("src/main.ts")).toBeInTheDocument();
  });

  it("opens a file and a commit diff when the user selects them", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /README\.md/ }));
    expect(await screen.findByText("# gitto")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /最初のコミット/ }));
    await waitFor(() =>
      expect(document.querySelector(".patch-view")).toHaveTextContent("@@ -1 +1 @@"),
    );
    expect(
      within(screen.getByLabelText("Repository path")).getByText("Commit abc12345"),
    ).toBeInTheDocument();
  });

  it("returns from a historical commit to the branch tip", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /最初のコミット/ }));
    await waitFor(() => expect(document.querySelector(".patch-view")).toBeInTheDocument());
    expect(screen.getByLabelText("Branch")).toHaveValue("abc123456789");
    await user.selectOptions(screen.getByLabelText("Branch"), "refs/heads/main");

    await waitFor(() => expect(document.querySelector(".patch-view")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Branch")).toHaveValue("refs/heads/main");
    expect(fetchMock).toHaveBeenCalledWith("/api/tree?revision=refs%2Fheads%2Fmain&path=");
  });

  it("keeps complete commit changes while viewing individual files and restores local changes at the branch tip", async () => {
    const commitFiles = [
      {
        path: "history/new.ts",
        oldPath: "history/old.ts",
        status: "renamed",
        additions: 9,
        deletions: 2,
        binary: false,
      },
      {
        path: "history/deleted.ts",
        oldPath: null,
        status: "deleted",
        additions: 0,
        deletions: 7,
        binary: false,
      },
    ];
    const fetchMock = installFetch({
      statusData: {
        ...status,
        untracked: [{ path: "local.md", oldPath: null, status: "untracked" }],
      },
      diffData: { patch: "@@ -1 +1 @@\n-old\n+new", files: [], truncated: true },
      commitStats: { patch: "", files: commitFiles, truncated: false },
    });
    const user = userEvent.setup();
    render(<App />);
    const changes = await screen.findByRole("complementary", { name: "Changed files" });
    await user.click(screen.getByRole("button", { name: /最初のコミット/ }));

    const renamed = await within(changes).findByRole("button", {
      name: "history/new.ts diff (Commit · renamed)",
    });
    expect(
      within(changes).getByRole("button", {
        name: "history/deleted.ts diff (Commit · deleted)",
      }),
    ).toHaveAttribute("data-change", "deleted");
    expect(within(renamed).getByText("+ 9")).toBeInTheDocument();
    expect(within(renamed).getByText("− 2")).toBeInTheDocument();
    expect(within(changes).getByText("2")).toBeInTheDocument();
    expect(within(changes).queryByText("main.ts")).not.toBeInTheDocument();
    expect(within(changes).queryByText("Untracked")).not.toBeInTheDocument();
    expect(within(changes).queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=commit&revision=abc123456789&statsOnly=true",
    );

    await user.click(renamed);
    await waitFor(() => expect(renamed).toHaveAttribute("aria-pressed", "true"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=commit&revision=abc123456789&path=history%2Fnew.ts",
    );
    await user.click(screen.getByRole("button", { name: "README.md" }));
    expect(await screen.findByText("# gitto")).toBeInTheDocument();
    expect(renamed).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close view" }));
    expect(renamed).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Branch"), "refs/heads/main");
    expect(
      await within(changes).findByRole("button", {
        name: "src/main.ts diff (Staged · modified)",
      }),
    ).toBeVisible();
    expect(within(changes).getByText("Untracked")).toBeInTheDocument();
    expect(within(changes).queryByText("new.ts")).not.toBeInTheDocument();
    expect(within(changes).getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("shows historical changes in a bare repository", async () => {
    installFetch({ repoData: { ...repo, bare: true } });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /最初のコミット/ }));

    const changes = screen.getByRole("complementary", { name: "Changed files" });
    expect(
      await within(changes).findByRole("button", {
        name: "README.md diff (Commit · modified)",
      }),
    ).toBeVisible();
    expect(within(changes).queryByText("No working tree")).not.toBeInTheDocument();
  });

  it("shows an empty commit without reporting the working tree as clean", async () => {
    installFetch({ diffData: { patch: "", files: [], truncated: false } });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /最初のコミット/ }));

    const changes = screen.getByRole("complementary", { name: "Changed files" });
    expect(await within(changes).findByText("This commit has no file changes.")).toBeVisible();
    expect(within(changes).queryByText("main.ts")).not.toBeInTheDocument();
  });

  it("opens staged changes as a diff", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "src/main.ts diff (Staged · modified)" }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=staged&revision=HEAD&path=src%2Fmain.ts",
    );
    await waitFor(() =>
      expect(document.querySelector(".patch-view")).toHaveTextContent("@@ -1 +1 @@"),
    );
  });

  it("opens unstaged changes as a diff", async () => {
    const fetchMock = installFetch({
      statusData: {
        ...status,
        staged: [],
        unstaged: [{ path: "src/main.ts", oldPath: null, status: "modified" }],
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "src/main.ts diff (Unstaged · modified)" }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=unstaged&revision=HEAD&path=src%2Fmain.ts",
    );
  });

  it("opens deleted files as a diff without a content action", async () => {
    const fetchMock = installFetch({
      statusData: {
        ...status,
        staged: [{ path: "src/main.ts", oldPath: null, status: "deleted" }],
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "src/main.ts diff (Staged · deleted)" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=staged&revision=HEAD&path=src%2Fmain.ts",
    );
    expect(screen.queryByRole("button", { name: "Content" })).not.toBeInTheDocument();
  });

  it("shows binary diff files even when the patch body is empty", async () => {
    installFetch({
      diffData: {
        patch: "",
        files: [
          {
            path: "image.png",
            oldPath: null,
            status: "modified",
            additions: 0,
            deletions: 0,
            binary: true,
          },
        ],
        truncated: false,
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /src\/main\.ts/ }));

    expect(await screen.findByText("Binary diff")).toBeInTheDocument();
    expect(screen.getByText("image.png")).toBeInTheDocument();
  });

  it("disables other navigation while a commit is loading", async () => {
    let releaseDiff!: () => void;
    const diffPromise = new Promise((resolve) => {
      releaseDiff = () => resolve(undefined);
    });
    installFetch({ diffPromise });
    const user = userEvent.setup();
    render(<App />);

    const commitButton = await screen.findByRole("button", {
      name: /最初のコミット/,
    });
    await user.click(commitButton);

    await waitFor(() => expect(commitButton).toBeDisabled());
    expect(screen.getByRole("button", { name: /README\.md/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /src\/main\.ts/ })).toBeDisabled();
    releaseDiff();
    await waitFor(() => expect(commitButton).not.toBeDisabled());
  });
});
