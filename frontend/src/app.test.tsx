import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import App from "./app";

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
const tree = {
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
    diffPromise?: Promise<unknown>;
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
      if (url.startsWith("/api/tree")) return response(tree);
      if (url === "/api/status") return response(statusData);
      if (url.startsWith("/api/file"))
        return response({
          path: "README.md",
          kind: "text",
          content: "# gitto\n",
          size: 7,
        });
      if (url.startsWith("/api/diff")) {
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
});

describe("App", () => {
  it("uses HEAD for the initial view and selects the matching full branch ref", async () => {
    const fetchMock = installFetch();
    render(<App />);

    await screen.findByRole("heading", { name: "sample-repo" });

    expect(fetchMock).toHaveBeenCalledWith("/api/commits?revision=HEAD&offset=0&limit=50");
    expect(fetchMock).toHaveBeenCalledWith("/api/tree?revision=HEAD&path=");
    expect(screen.getByLabelText("ブランチ")).toHaveValue("refs/heads/main");
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

    await screen.findByRole("heading", { name: "sample-repo" });

    expect(screen.getByRole("option", { name: "HEAD" })).toBeInTheDocument();
    expect(screen.getByLabelText("ブランチ")).toHaveValue("HEAD");
  });

  it("displays repository, history, tree, and changes from the API", async () => {
    installFetch();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "sample-repo" })).toBeInTheDocument();
    expect(screen.getByText("最初のコミット")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("src/main.ts")).toBeInTheDocument();
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
    expect(screen.getByText(/コミット abc12345/)).toBeInTheDocument();
  });

  it("reads staged file contents from the index", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "内容" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/file?source=index&revision=HEAD&path=src%2Fmain.ts",
    );
    expect(await screen.findByText("# gitto")).toBeInTheDocument();
  });

  it("reads unstaged file contents from the worktree", async () => {
    const fetchMock = installFetch({
      statusData: {
        ...status,
        staged: [],
        unstaged: [{ path: "src/main.ts", oldPath: null, status: "modified" }],
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "内容" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/file?source=worktree&revision=HEAD&path=src%2Fmain.ts",
    );
  });

  it("disables content for deleted files", async () => {
    installFetch({
      statusData: {
        ...status,
        staged: [{ path: "src/main.ts", oldPath: null, status: "deleted" }],
      },
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "内容" })).toBeDisabled();
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

    expect(await screen.findByText("バイナリ差分")).toBeInTheDocument();
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
