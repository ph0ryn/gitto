import "@testing-library/jest-dom/vitest";
import { icons } from "@iconify-json/catppuccin";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import App from "./app";

import type { TreeEntry } from "./fileTree";

const repo = {
  appVersion: "9.8.7",
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
    json: async () => structuredClone(data),
  }) as Promise<Response>;
}

function installFetch(
  options: {
    repoData?: typeof repo;
    commitData?: typeof commits;
    statusData?: TestStatus;
    diffData?: unknown;
    commitStats?: unknown;
    diffPromise?: Promise<unknown>;
    fileContent?: string;
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
      if (url.startsWith("/api/commits")) return response(options.commitData ?? commits);
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
          content: options.fileContent ?? "# gitto\n",
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
  vi.useRealTimers();
  document.title = "gitto";
});

describe("App", () => {
  it("shows Catppuccin artwork in changes and the file viewer", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<App />);

    const change = await screen.findByRole("button", {
      name: "src/main.ts diff (Staged · modified)",
    });
    expect(change.querySelector("svg.entry-icon path")).toHaveAttribute(
      "d",
      icons.icons.typescript.body.match(/ d="([^"]+)"/)?.[1],
    );
    expect(change).toHaveAttribute("data-change", "modified");
    expect(change.querySelector(".status-dot")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "README.md" }));
    const viewer = screen.getByRole("region", { name: "Repository content" });
    await within(viewer).findByRole("heading", { name: "README.md" });
    expect(viewer.querySelector("header svg.entry-icon path")).toHaveAttribute(
      "d",
      icons.icons.readme.body.match(/ d="([^"]+)"/)?.[1],
    );
    expect(
      fetchMock.mock.calls.every(
        ([input]) => typeof input === "string" && input.startsWith("/api/"),
      ),
    ).toBe(true);
  });

  it("shows read-only staging checkboxes after change counts", async () => {
    installFetch({
      statusData: {
        staged: [{ path: "staged.ts", oldPath: null, status: "modified" }],
        unstaged: [{ path: "binary.png", oldPath: null, status: "modified" }],
        untracked: [{ path: "new.md", oldPath: null, status: "untracked" }],
        conflicts: [],
      },
      stats: {
        "staged:staged.ts": { additions: 39, deletions: 41 },
        "unstaged:binary.png": { additions: 0, deletions: 0, binary: true },
      },
    });
    render(<App />);

    const staged = await screen.findByRole("checkbox", { name: "Staged: staged.ts" });
    expect(staged).toBeChecked();
    expect(staged).toBeDisabled();
    const stagedRow = screen.getByRole("button", {
      name: "staged.ts diff (Staged · modified)",
    });
    expect(within(stagedRow).getByText("+ 39")).toBeInTheDocument();
    const deletions = within(stagedRow).getByText("− 41");
    expect(
      deletions.compareDocumentPosition(staged) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(stagedRow).queryByText("S")).not.toBeInTheDocument();

    for (const path of ["binary.png", "new.md"]) {
      const checkbox = screen.getByRole("checkbox", { name: `Staged: ${path}` });
      expect(checkbox).not.toBeChecked();
      expect(checkbox).toBeDisabled();
    }
    expect(screen.getByText("Binary")).toBeInTheDocument();
  });

  it.each([
    { hour: 0, time: "00:05" },
    { hour: 14, time: "14:05" },
  ])("shows the commit date with the local 24-hour time ($time)", async ({ hour, time }) => {
    installFetch({
      commitData: {
        ...commits,
        commits: [{ ...commits.commits[0], time: new Date(2026, 9, 12, hour, 5).getTime() / 1000 }],
      },
    });
    render(<App />);

    const history = await screen.findByRole("complementary", { name: "Commit history" });
    const commit = within(history).getByRole("button", { name: /最初のコミット/ });
    expect(commit.querySelector("time")?.textContent).toBe(`Oct 12, 2026, ${time}`);
  });

  it.each([
    { initial: "file", next: "file" },
    { initial: "file", next: "diff" },
    { initial: "diff", next: "file" },
    { initial: "diff", next: "diff" },
  ])(
    "keeps the $initial preview and navigation unchanged while opening a $next",
    async ({ initial, next }) => {
      const fetchMock = installFetch({
        trees: {
          "": [...tree.entries, { name: "next.ts", path: "next.ts", kind: "blob", size: 7 }],
        },
        statusData: {
          ...status,
          unstaged: [{ path: "src/next.ts", oldPath: null, status: "modified" }],
        },
      });
      const user = userEvent.setup();
      render(<App />);
      const files = await screen.findByRole("complementary", { name: "File tree" });
      const changes = screen.getByRole("complementary", { name: "Changed files" });
      const history = screen.getByRole("complementary", { name: "Commit history" });
      const content = screen.getByRole("region", { name: "Repository content" });
      const initialPath = initial === "file" ? "README.md" : "src/main.ts";
      await user.click(
        screen.getByRole("button", {
          name: initial === "file" ? "README.md" : "src/main.ts diff (Staged · modified)",
        }),
      );
      await within(content).findByRole("heading", { name: initialPath });
      const preview = content.querySelector(initial === "file" ? ".code-view" : ".diff-view");
      let resolvePreview!: (value: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolvePreview = resolve;
          }),
      );
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver((records) => mutations.push(...records));
      for (const navigation of [files, changes, history]) {
        observer.observe(navigation, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        });
      }
      await user.click(
        screen.getByRole("button", {
          name: next === "file" ? "next.ts" : "src/next.ts diff (Unstaged · modified)",
        }),
      );

      expect(content).toHaveAttribute("aria-busy", "true");
      expect(preview).toBeInTheDocument();
      expect(within(content).getByRole("heading", { name: initialPath })).toBeVisible();
      expect(within(content).queryByText("Loading…")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Branch")).toBeEnabled();
      expect(mutations).toHaveLength(0);
      observer.disconnect();

      await act(async () => {
        resolvePreview(
          await response(
            next === "file"
              ? { path: "next.ts", kind: "text", content: "next\n", size: 5 }
              : { patch: "@@ -1 +1 @@\n-old\n+next", files: [], truncated: false },
          ),
        );
      });
      expect(
        within(content).getByRole("heading", {
          name: next === "file" ? "next.ts" : "src/next.ts",
        }),
      ).toBeVisible();
      expect(content).toHaveAttribute("aria-busy", "false");
      expect(
        content.querySelector(next === "file" ? ".code-view" : ".diff-view"),
      ).toHaveTextContent("next");
    },
  );

  it.each(["file", "diff"])(
    "keeps the current preview and reports a failed %s request",
    async (next) => {
      const fetchMock = installFetch();
      const user = userEvent.setup();
      render(<App />);
      const file = await screen.findByRole("button", { name: "README.md" });
      await user.click(file);
      await screen.findByText("# gitto");
      const preview = document.querySelector(".code-view");
      fetchMock.mockImplementationOnce(() => response({ error: "Preview unavailable" }, 500));
      await user.click(
        next === "file"
          ? file
          : screen.getByRole("button", {
              name: "src/main.ts diff (Staged · modified)",
            }),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent("Preview unavailable");
      expect(preview).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "README.md" })).toBeVisible();
      expect(file).toHaveClass("is-selected");
      expect(screen.getByRole("region", { name: "Repository content" })).toHaveAttribute(
        "aria-busy",
        "false",
      );
    },
  );

  it.each([
    { first: "file", action: "diff", fails: false },
    { first: "diff", action: "file", fails: true },
    { first: "file", action: "close", fails: false },
    { first: "diff", action: "commit", fails: false },
    { first: "file", action: "branch", fails: true },
  ])(
    "ignores an obsolete $first request after $action (fails: $fails)",
    async ({ first, action, fails }) => {
      const fetchMock = installFetch({
        repoData: {
          ...repo,
          branches: [...repo.branches, { name: "other", revision: "refs/heads/other" }],
        },
        trees: {
          "": [...tree.entries, { name: "next.ts", path: "next.ts", kind: "blob", size: 7 }],
        },
      });
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: "README.md" }));
      await screen.findByText("# gitto");
      let resolvePreview!: (value: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolvePreview = resolve;
          }),
      );
      const file = screen.getByRole("button", { name: "next.ts" });
      const diff = screen.getByRole("button", { name: "src/main.ts diff (Staged · modified)" });
      await user.click(first === "file" ? file : diff);
      const signal = fetchMock.mock.lastCall?.[1]?.signal;
      switch (action) {
        case "file":
          await user.click(file);
          await screen.findByRole("heading", { name: "next.ts" });
          break;
        case "diff":
          await user.click(diff);
          await screen.findByRole("heading", { name: "src/main.ts" });
          break;
        case "close":
          await user.click(screen.getByRole("button", { name: "Close view" }));
          break;
        case "commit":
          await user.click(screen.getByRole("button", { name: /最初のコミット/ }));
          await screen.findByRole("heading", { name: "abc1234 changes" });
          break;
        case "branch":
          await user.selectOptions(screen.getByLabelText("Branch"), "refs/heads/other");
          await waitFor(() =>
            expect(screen.getByLabelText("Branch")).toHaveValue("refs/heads/other"),
          );
          break;
      }
      const content = screen.getByRole("region", { name: "Repository content" });
      const snapshot = content.innerHTML;
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        resolvePreview(
          await response(
            fails
              ? { error: "Obsolete failure" }
              : first === "file"
                ? { path: "next.ts", kind: "text", content: "obsolete\n", size: 9 }
                : { patch: "@@ -1 +1 @@\n-old\n+obsolete", files: [], truncated: false },
            fails ? 500 : 200,
          ),
        );
      });

      expect(content.innerHTML).toBe(snapshot);
      expect(content).toHaveAttribute("aria-busy", "false");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("does not restore a closed file when a polling preview finishes in the same update", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = installFetch();
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    });
    const originalFetch = fetchMock.getMockImplementation()!;
    let resolveDiff!: (value: Response) => void;
    const pendingDiff = new Promise<Response>((resolve) => {
      resolveDiff = resolve;
    });
    fetchMock.mockImplementation((input, init) =>
      typeof input === "string" && input.startsWith("/api/diff?source=worktree")
        ? pendingDiff
        : originalFetch(input, init),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close view" }));
      resolveDiff(await response({ patch: "", files: [], truncated: false }));
    });

    expect(screen.queryByText("# gitto")).not.toBeInTheDocument();
    expect(screen.getByText("Open a file")).toBeVisible();
  });

  it("automatically updates history, branches, changes, files, and the open file", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const options = {
      repoData: structuredClone(repo),
      commitData: structuredClone(commits),
      statusData: { staged: [], unstaged: [], untracked: [], conflicts: [] } as TestStatus,
      fileContent: "before\n",
      trees: {
        "": [{ name: "src", path: "src", kind: "tree", size: null }],
        src: [{ name: "main.ts", path: "src/main.ts", kind: "blob", size: 7 }],
      } as Record<string, TreeEntry[]>,
    };
    installFetch(options);
    await act(async () => {
      render(<App />);
    });
    const files = screen.getByRole("complementary", { name: "File tree" });
    await act(async () => {
      fireEvent.click(within(files).getByRole("button", { name: "src" }));
    });
    await act(async () => {
      fireEvent.click(within(files).getByRole("button", { name: "main.ts" }));
    });
    expect(document.querySelector(".code-view code")).toHaveTextContent("before");

    options.repoData.head = "feature";
    options.repoData.branches.push({ name: "feature", revision: "refs/heads/feature" });
    options.commitData.commits.unshift({
      ...commits.commits[0],
      id: "def123456789",
      shortId: "def1234",
      summary: "New commit",
    });
    options.statusData.unstaged.push({ path: "src/main.ts", oldPath: null, status: "modified" });
    options.fileContent = "after\n";
    options.trees[""].push({ name: "new.txt", path: "new.txt", kind: "blob", size: 3 });
    options.trees.src.push({ name: "next.ts", path: "src/next.ts", kind: "blob", size: 3 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByRole("button", { name: /New commit/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Branch")).toHaveValue("refs/heads/feature");
    expect(
      screen.getByRole("button", { name: "src/main.ts diff (Unstaged · modified)" }),
    ).toBeInTheDocument();
    expect(within(files).getByRole("button", { name: "new.txt" })).toBeInTheDocument();
    expect(within(files).getByRole("button", { name: "next.ts" })).toBeInTheDocument();
    expect(within(files).getByRole("button", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(files).getByRole("button", { name: "main.ts" })).toHaveClass("is-selected");
    expect(document.querySelector(".code-view code")).toHaveTextContent("after");
  });

  it("automatically refreshes the selected working diff without clearing its selection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const options = {
      diffData: {
        patch:
          "diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+before\n",
        files: [
          {
            path: "main.ts",
            oldPath: null,
            status: "modified",
            additions: 1,
            deletions: 1,
            binary: false,
          },
        ],
        truncated: false,
      },
    };
    installFetch(options);
    await act(async () => {
      render(<App />);
    });
    const change = screen.getByRole("button", { name: "src/main.ts diff (Staged · modified)" });
    await act(async () => {
      fireEvent.click(change);
    });
    options.diffData.patch = options.diffData.patch.replace("+before", "+after");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("table", { name: "main.ts diff" })).toHaveTextContent("after");
    expect(change).toHaveAttribute("aria-pressed", "true");
  });

  it("pauses while hidden, refreshes on return and focus, and stops after unmount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const fetchMock = installFetch();
    let unmount!: () => void;
    await act(async () => {
      unmount = render(<App />).unmount;
    });
    fetchMock.mockClear();
    hidden.mockReturnValue(true);
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/repo")).toHaveLength(1);
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/repo")).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/repo")).toHaveLength(3);
    unmount();
    fetchMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not overlap slow refreshes or apply them after the user selects a commit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = installFetch();
    await act(async () => {
      render(<App />);
    });
    let resolveRepo!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveRepo = resolve;
    });
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(() => pending);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0][1]?.signal;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /最初のコミット/ }));
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolveRepo(await response({ ...repo, name: "Old response" }));
    });
    expect(document.title).toBe("sample-repo | gitto");
    expect(screen.getByRole("button", { name: /最初のコミット/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Branch")).toHaveValue(commits.commits[0].id);
  });

  it("keeps the preview through a refresh failure and retries automatically", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = installFetch();
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    });
    fetchMock.mockImplementationOnce(() => response({ error: "Temporarily unavailable" }, 500));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Temporarily unavailable");
    expect(screen.getByText("# gitto")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("# gitto")).toBeInTheDocument();
  });

  it("updates the workspace even when the open file is no longer available", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const options = { commitData: structuredClone(commits) };
    const fetchMock = installFetch(options);
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    });
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) =>
      typeof input === "string" && input.startsWith("/api/file")
        ? response({ error: "File was removed" }, 404)
        : originalFetch(input, init),
    );
    options.commitData.commits.unshift({
      ...commits.commits[0],
      id: "def123456789",
      summary: "New commit",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("File was removed");
    expect(screen.getByRole("button", { name: /New commit/ })).toBeInTheDocument();
    expect(screen.getByText("# gitto")).toBeInTheDocument();
  });

  it("keeps updating the workspace while a preview refresh is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const options = { commitData: structuredClone(commits) };
    const fetchMock = installFetch(options);
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    });
    const originalFetch = fetchMock.getMockImplementation()!;
    let resolveFile!: (value: Response) => void;
    const pendingFile = new Promise<Response>((resolve) => {
      resolveFile = resolve;
    });
    fetchMock.mockClear();
    fetchMock.mockImplementation((input, init) =>
      typeof input === "string" && input.startsWith("/api/file")
        ? pendingFile
        : originalFetch(input, init),
    );
    options.commitData.commits.unshift({
      ...commits.commits[0],
      id: "def123456789",
      summary: "New commit",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("button", { name: /New commit/ })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/repo")).toHaveLength(3);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => typeof url === "string" && url.startsWith("/api/file"),
      ),
    ).toHaveLength(1);
    await act(async () => {
      resolveFile(
        await response({ path: "README.md", kind: "text", content: "Updated preview\n", size: 16 }),
      );
    });
    expect(screen.getByText("Updated preview")).toBeInTheDocument();
  });

  it("keeps a historical commit selected while its branch history updates", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const options = { commitData: structuredClone(commits) };
    const fetchMock = installFetch(options);
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /最初のコミット/ }));
    });
    fetchMock.mockClear();
    options.commitData.commits.unshift({
      ...commits.commits[0],
      id: "def123456789",
      summary: "New commit",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("button", { name: /New commit/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /最初のコミット/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Branch")).toHaveValue(commits.commits[0].id);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/commits?revision=HEAD&offset=0&limit=50",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tree?revision=${commits.commits[0].id}&path=`,
      expect.anything(),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("source=commit"),
      ),
    ).toBe(false);
  });

  it("refreshes every loaded history page without resetting pagination", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const history = Array.from({ length: 75 }, (_, index) => ({
      ...commits.commits[0],
      id: `commit-${index}`,
      summary: `Commit ${index}`,
    }));
    const fetchMock = installFetch();
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      if (typeof input !== "string" || !input.startsWith("/api/commits"))
        return originalFetch(input, init);
      const query = new URL(input, "http://localhost").searchParams;
      const offset = Number(query.get("offset"));
      return response({
        commits: history.slice(offset, offset + 50),
        hasMore: offset + 50 < history.length,
      });
    });
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    });
    const pane = screen.getByRole("complementary", { name: "Commit history" });
    expect(within(pane).getAllByRole("button")).toHaveLength(75);
    history.unshift({ ...commits.commits[0], id: "new-commit", summary: "New commit" });
    fetchMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(within(pane).getAllByRole("button")).toHaveLength(76);
    expect(screen.getByRole("button", { name: /New commit/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/commits?revision=HEAD&offset=50&limit=50",
      expect.anything(),
    );
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("uses HEAD after an open untracked file is committed and then staged for deletion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const options = {
      statusData: {
        staged: [],
        unstaged: [],
        conflicts: [],
        untracked: [{ path: "notes.md", oldPath: null, status: "untracked" }],
      } as TestStatus,
      trees: { "": [] } as Record<string, TreeEntry[]>,
    };
    const fetchMock = installFetch(options);
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "notes.md" }));
    });
    options.statusData.untracked = [];
    options.statusData.staged = [{ path: "notes.md", oldPath: null, status: "deleted" }];
    options.trees[""] = [{ name: "notes.md", path: "notes.md", kind: "blob", size: 7 }];
    fetchMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/file?source=commit&revision=HEAD&path=notes.md",
      expect.anything(),
    );
    expect(screen.getByText("Removed from working tree")).toBeInTheDocument();
  });

  it("shows a single-column diff with source syntax and separate change gutters", async () => {
    installFetch({
      diffData: {
        patch:
          'diff --git a/main.ts b/main.ts\nindex 123..456 100644\n--- a/main.ts\n+++ b/main.ts\n@@ -4 +4 @@\n-const value = "old";\n+const value = "new";\n',
        files: [
          {
            path: "main.ts",
            oldPath: null,
            status: "modified",
            additions: 1,
            deletions: 1,
            binary: false,
          },
        ],
        truncated: false,
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /最初のコミット/ }));

    const diff = await screen.findByRole("table", { name: "main.ts diff" });
    const deleted = within(diff).getByRole("row", { name: /Deleted line 4/ });
    const added = within(diff).getByRole("row", { name: /Added line 4/ });
    expect(deleted.querySelector("code")?.textContent).toBe('const value = "old";');
    expect(added.querySelector("code")?.textContent).toBe('const value = "new";');
    expect(added.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(within(diff).getAllByRole("columnheader", { name: "Code" })).toHaveLength(1);
    expect(diff).not.toHaveTextContent("@@");
    expect(diff).not.toHaveTextContent("diff --git");
    expect(diff).not.toHaveTextContent("index 123");
  });

  it("highlights source files and shows line numbers without changing the source text", async () => {
    const content = 'const message = "hello";\n\nconsole.log(message);\n';
    installFetch({
      fileContent: content,
      trees: { "": [{ name: "main.ts", path: "main.ts", kind: "blob", size: content.length }] },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "main.ts" }));
    await waitFor(() =>
      expect(document.querySelector(".code-view code")).toHaveTextContent("hello"),
    );

    expect(document.querySelector(".code-view code")?.textContent).toBe(content);
    expect(document.querySelector(".code-view .hljs-keyword")).toHaveTextContent("const");
    expect(document.querySelector(".line-numbers")).toHaveTextContent("1 2 3");
    expect(document.querySelector(".line-numbers")).toHaveAttribute("aria-hidden", "true");
  });

  it("opens working content with changes against HEAD and shows its changed line", async () => {
    const fetchMock = installFetch({
      fileContent: "new\n",
      trees: { "": [{ name: "main.ts", path: "main.ts", kind: "blob", size: 4 }] },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "main.ts" }));

    expect(await screen.findByRole("img", { name: "Modified line 1" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/file?source=worktree&revision=HEAD&path=main.ts", {
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/diff?source=worktree&revision=HEAD&path=main.ts", {
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps explicitly removed files visible with deletion markers", async () => {
    const fetchMock = installFetch({
      fileContent: "old\n",
      trees: { "": [{ name: "main.ts", path: "main.ts", kind: "blob", size: 4 }] },
      statusData: {
        ...status,
        staged: [],
        unstaged: [{ path: "main.ts", oldPath: null, status: "deleted" }],
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "main.ts" }));
    expect(await screen.findByRole("img", { name: "Deleted line 1" })).toBeInTheDocument();
    expect(screen.getByText("Removed from working tree")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/file?source=commit&revision=HEAD&path=main.ts", {
      signal: expect.any(AbortSignal),
    });
  });

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
      { signal: expect.any(AbortSignal) },
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const statusData: TestStatus = { ...status, untracked: [] };
    const fetchMock = installFetch({
      statusData,
      trees: {
        "": [{ name: "src", path: "src", kind: "tree", size: null }],
        src: [{ name: "main.ts", path: "src/main.ts", kind: "blob", size: 12 }],
      },
    });
    await act(async () => {
      render(<App />);
    });
    const files = screen.getByRole("complementary", { name: "File tree" });
    const folder = within(files).getByRole("button", { name: "src" });
    await act(async () => {
      fireEvent.click(folder);
    });
    expect(within(files).getByRole("button", { name: "main.ts" })).toBeVisible();
    statusData.untracked = [{ path: "src/new.ts", oldPath: null, status: "untracked" }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(within(files).getByRole("button", { name: "new.ts" })).toBeVisible();
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/tree?revision=HEAD&path=src"),
    ).toHaveLength(2);
    statusData.staged = [
      ...statusData.staged,
      { path: "src/new.ts", oldPath: null, status: "added" },
    ];
    statusData.untracked = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const added = within(files).getByRole("button", { name: "new.ts" });
    expect(added).toHaveAttribute("data-change", "added");
    await act(async () => {
      fireEvent.click(added);
    });
    expect(screen.getByText("# gitto")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/file?source=worktree&revision=HEAD&path=src%2Fnew.ts",
      { signal: expect.any(AbortSignal) },
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
    expect(folder).toHaveAttribute("aria-expanded", "true");
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
      { signal: expect.any(AbortSignal) },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=unstaged&revision=HEAD&path=src%2Fmain.ts",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("keeps the preview when refreshed diff statistics fail", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = installFetch();
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    });
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/diff?source=staged&statsOnly=true") {
        return response({ error: "Statistics unavailable" }, 500);
      }
      return originalFetch(input, init);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Statistics unavailable");
    expect(screen.getByText("# gitto")).toBeInTheDocument();
  });

  it("uses the repository name in the page title and file tree heading", async () => {
    installFetch();
    render(<App />);

    await waitFor(() => expect(document.title).toBe("sample-repo | gitto"));
    const files = screen.getByRole("complementary", { name: "File tree" });
    expect(within(files).getByRole("heading", { name: repo.name })).toBeVisible();
    expect(within(files).getByRole("heading", { name: repo.name }).parentElement).toHaveTextContent(
      /^sample-repo$/,
    );
    expect(within(files).queryByRole("heading", { name: "Files" })).not.toBeInTheDocument();
  });

  it("shows the complete path of an open file and identifies the read-only workspace", async () => {
    installFetch({
      trees: {
        "": [{ name: "src", path: "src", kind: "tree", size: null }],
        src: [{ name: "main.ts", path: "src/main.ts", kind: "blob", size: 7 }],
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "src" }));
    await user.click(await screen.findByRole("button", { name: "main.ts" }));

    const content = screen.getByRole("region", { name: "Repository content" });
    expect(await within(content).findByRole("heading", { name: "src/main.ts" })).toBeVisible();
    expect(
      within(screen.getByLabelText("Repository information")).getByText(
        "A read-only local Git browser",
      ),
    ).toBeVisible();
  });

  it("groups the repository details before the app name, description, and version in the footer", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "README.md" }));
    await screen.findByText("# gitto");

    const footer = screen.getByLabelText("Repository information");
    const details = [
      within(footer).getByText(repo.path),
      within(footer).getByText("HEAD · abc1234"),
      within(footer).getByText("7 B"),
      within(footer).getByText("Gitto"),
      within(footer).getByText("A read-only local Git browser"),
      within(footer).getByText(`v${repo.appVersion}`),
    ];
    for (let index = 1; index < details.length; index++) {
      expect(
        details[index - 1].compareDocumentPosition(details[index]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(details[0]).toHaveAttribute("title", repo.path);
    expect(details[1]).toHaveAttribute("title", commits.commits[0].id);

    await user.click(screen.getByRole("button", { name: "Close view" }));
    expect(within(footer).queryByText("7 B")).not.toBeInTheDocument();
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
    const footer = screen.getByLabelText("Repository information");
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
    await waitFor(() => expect(document.querySelector(".diff-table")).toHaveTextContent("new"));
    expect(document.querySelector(".diff-old.deleted")).toHaveTextContent("1");
    expect(document.querySelector(".diff-new.added")).toHaveTextContent("1");
    expect(document.querySelector(".diff-sign.added")).toHaveTextContent("+");
    expect(
      within(screen.getByLabelText("Repository information")).getByText("Commit abc12345"),
    ).toBeInTheDocument();
  });

  it("returns from a historical commit to the branch tip", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /最初のコミット/ }));
    await waitFor(() => expect(document.querySelector(".diff-table")).toBeInTheDocument());
    expect(screen.getByLabelText("Branch")).toHaveValue("abc123456789");
    await user.selectOptions(screen.getByLabelText("Branch"), "refs/heads/main");

    await waitFor(() => expect(document.querySelector(".diff-table")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Branch")).toHaveValue("refs/heads/main");
    expect(fetchMock).toHaveBeenCalledWith("/api/tree?revision=refs%2Fheads%2Fmain&path=");
  });

  it.each([
    { head: "main", branch: "refs/heads/main" },
    { head: "deadbee", branch: "HEAD" },
  ])("returns from a viewed commit to HEAD ($head)", async ({ head, branch }) => {
    const fetchMock = installFetch({
      repoData: {
        ...repo,
        head,
        branches: [{ name: "feature", revision: "refs/heads/feature" }, ...repo.branches],
      },
    });
    const user = userEvent.setup();
    render(<App />);

    const history = await screen.findByRole("complementary", { name: "Commit history" });
    expect(within(history).queryByRole("button", { name: "Back to HEAD" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Branch"), "refs/heads/feature");
    await user.click(within(history).getByRole("button", { name: /最初のコミット/ }));
    const backToHead = await within(history).findByRole("button", { name: "Back to HEAD" });
    expect(
      within(history).getByRole("heading", { name: "Commits" }).parentElement,
    ).toContainElement(backToHead);
    expect(
      backToHead.compareDocumentPosition(within(history).getByText("1")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(
      within(screen.getByRole("complementary", { name: "File tree" })).getByRole("button", {
        name: "README.md",
      }),
    );
    await screen.findByText("# gitto");
    await user.click(screen.getByRole("button", { name: "Close view" }));
    expect(within(history).getByRole("button", { name: "Back to HEAD" })).toBeVisible();
    fetchMock.mockClear();
    await user.click(within(history).getByRole("button", { name: "Back to HEAD" }));

    await waitFor(() =>
      expect(
        within(history).queryByRole("button", { name: "Back to HEAD" }),
      ).not.toBeInTheDocument(),
    );
    expect(within(history).getByRole("button", { name: /最初のコミット/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByLabelText("Branch")).toHaveValue(branch);
    expect(
      screen.getByRole("button", { name: "src/main.ts diff (Staged · modified)" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Repository information")).toHaveTextContent("HEAD · abc1234");
    expect(fetchMock).toHaveBeenCalledWith("/api/commits?revision=HEAD&offset=0&limit=50");
    expect(fetchMock).toHaveBeenCalledWith("/api/tree?revision=HEAD&path=");
  });

  it("disables Back to HEAD while loading and keeps it available if loading fails", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /最初のコミット/ }));
    const backToHead = await screen.findByRole("button", { name: "Back to HEAD" });
    let releaseHead!: () => void;
    const headResponse = new Promise<Response>((resolve) => {
      releaseHead = () => void response({ error: "Could not load HEAD." }, 500).then(resolve);
    });
    fetchMock.mockImplementationOnce(() => headResponse);

    await user.click(backToHead);
    expect(backToHead).toBeDisabled();
    expect(screen.getByLabelText("Branch")).toBeDisabled();
    releaseHead();

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load HEAD.");
    expect(backToHead).toBeEnabled();
    expect(screen.getByLabelText("Branch")).toHaveValue("abc123456789");
    await user.click(backToHead);
    await waitFor(() => expect(backToHead).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
    expect(within(changes).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=commit&revision=abc123456789&statsOnly=true",
    );

    await user.click(renamed);
    await waitFor(() => expect(renamed).toHaveAttribute("aria-pressed", "true"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diff?source=commit&revision=abc123456789&path=history%2Fnew.ts",
      { signal: expect.any(AbortSignal) },
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
      { signal: expect.any(AbortSignal) },
    );
    await waitFor(() => expect(document.querySelector(".diff-table")).toHaveTextContent("new"));
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
      { signal: expect.any(AbortSignal) },
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
      { signal: expect.any(AbortSignal) },
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
