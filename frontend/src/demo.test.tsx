import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import App from "./app";
import { demoFetch } from "./demo";
import { parseDiff } from "./diffLines";

import type { DiffView } from "./diffViewer";
import type { TreeEntry } from "./fileTree";
import type { SearchResult } from "./searchResults";

beforeEach(() => {
  vi.stubGlobal("fetch", demoFetch);
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  document.title = "gitto";
});

describe("Interactive demo", () => {
  it("browses working files, staged changes, untracked files, and search results in the real UI", async () => {
    const user = userEvent.setup();
    render(<App />);
    const tree = await screen.findByRole("complementary", { name: "File tree" });
    const viewer = screen.getByRole("region", { name: "Repository content" });
    expect(screen.getByRole("heading", { name: "hello-gitto" })).toBeVisible();
    await user.click(within(tree).getByRole("button", { name: "src" }));
    await user.click(await within(tree).findByRole("button", { name: "greet.ts" }));
    expect(await within(viewer).findByRole("heading", { name: "src/greet.ts" })).toBeVisible();
    expect(viewer).toHaveTextContent("Hi,");

    await user.click(screen.getByRole("button", { name: "src/greet.ts diff (Staged · modified)" }));
    expect(await screen.findByRole("table", { name: "src/greet.ts diff" })).toHaveTextContent(
      "Hello,",
    );
    expect(viewer).toHaveTextContent("Hi,");
    await user.click(screen.getByRole("button", { name: "README.md diff (Unstaged · modified)" }));
    expect(await screen.findByRole("table", { name: "README.md diff" })).toHaveTextContent(
      "fallback greeting",
    );
    await user.click(
      screen.getByRole("button", { name: "notes/todo.md diff (Untracked · untracked)" }),
    );
    expect(await screen.findByRole("table", { name: "notes/todo.md diff" })).toHaveTextContent(
      "Add greeting tests",
    );

    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search repository" }),
      "Add greeting tests{Enter}",
    );
    expect(await screen.findByText("1 matching line in 1 file")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open notes/todo.md at line 3" }));
    expect(await within(viewer).findByRole("heading", { name: "notes/todo.md" })).toBeVisible();
    expect(viewer).toHaveTextContent("Add greeting tests");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("browses historical snapshots and switches branches in the real UI", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /feat: handle empty names/ }));
    const viewer = screen.getByRole("region", { name: "Repository content" });
    expect(await screen.findByRole("table", { name: "src/greet.ts diff" })).toHaveTextContent(
      "friend",
    );
    const tree = screen.getByRole("complementary", { name: "File tree" });
    await user.click(within(tree).getByRole("button", { name: "src" }));
    await user.click(await within(tree).findByRole("button", { name: "greet.ts" }));
    expect(await within(viewer).findByRole("heading", { name: "src/greet.ts" })).toBeVisible();
    expect(viewer).toHaveTextContent("Hello,");
    expect(viewer).not.toHaveTextContent("Hi,");

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Branch" }),
      "refs/heads/feature/evening",
    );
    await user.click(await screen.findByRole("button", { name: /feat: add an evening greeting/ }));
    expect(await screen.findByRole("table", { name: "src/main.ts diff" })).toHaveTextContent(
      "evening visitor",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Branch" }), "refs/heads/main");
    await screen.findByText("Tracked");
    expect(
      screen.queryByRole("button", { name: /feat: add an evening greeting/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

async function read<T>(url: string): Promise<T> {
  const response = await demoFetch(url);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

describe("Demo API consistency", () => {
  it.each([
    { source: "staged", before: "commit", after: "index" },
    { source: "unstaged", before: "index", after: "worktree" },
    { source: "untracked", before: null, after: "worktree" },
  ])(
    "keeps $source status, counts, patches, and file contents consistent",
    async ({ source, before, after }) => {
      const status =
        await read<Record<string, Array<{ path: string; status: string; oldPath: null }>>>(
          "/api/status",
        );
      const view = await read<DiffView>(`/api/diff?source=${source}`);
      const stats = await read<DiffView>(`/api/diff?source=${source}&statsOnly=true`);
      expect(stats).toEqual({ ...view, patch: "" });
      expect(view.files.map(({ path, status, oldPath }) => ({ path, status, oldPath }))).toEqual(
        status[source],
      );
      for (const file of view.files) {
        const path = encodeURIComponent(file.path);
        const single = await read<DiffView>(`/api/diff?source=${source}&path=${path}`);
        expect(single.files).toEqual([file]);
        const rows = parseDiff(single.patch);
        expect(rows.filter((row) => row.newLine !== null && row.oldLine === null)).toHaveLength(
          file.additions,
        );
        expect(rows.filter((row) => row.oldLine !== null && row.newLine === null)).toHaveLength(
          file.deletions,
        );
        const oldContent = before
          ? (await read<{ content: string }>(`/api/file?source=${before}&path=${path}`)).content
          : "";
        const next = await read<{ content: string; size: number }>(
          `/api/file?source=${after}&path=${path}`,
        );
        expect(
          rows
            .filter((row) => row.oldLine !== null)
            .map((row) => `${row.text.slice(1)}\n`)
            .join(""),
        ).toBe(oldContent);
        expect(
          rows
            .filter((row) => row.newLine !== null)
            .map((row) => `${row.text.slice(1)}\n`)
            .join(""),
        ).toBe(next.content);
        expect(next.size).toBe(new TextEncoder().encode(next.content).length);
      }
    },
  );

  it("keeps every branch's history, nested trees, and search snippets tied to its snapshot", async () => {
    const repo = await read<{ branches: Array<{ revision: string }> }>("/api/repo");
    for (const branch of repo.branches) {
      const revision = encodeURIComponent(branch.revision);
      const history = await read<{
        commits: Array<{ id: string; shortId: string; parents: string[] }>;
        hasMore: boolean;
      }>(`/api/commits?revision=${revision}`);
      expect(history.hasMore).toBe(false);
      const page = await read<{ commits: typeof history.commits; hasMore: boolean }>(
        `/api/commits?revision=${revision}&offset=1&limit=1`,
      );
      expect(page.commits).toEqual(history.commits.slice(1, 2));
      expect(page.hasMore).toBe(history.commits.length > 2);
      for (const commit of history.commits) {
        expect(commit.id).toMatch(/^[0-9a-f]{40}$/);
        expect(commit.shortId).toBe(commit.id.slice(0, 7));
        const pending = [""];
        while (pending.length) {
          const path = pending.pop()!;
          const listing = await read<{ entries: TreeEntry[] }>(
            `/api/tree?revision=${commit.id}&path=${encodeURIComponent(path)}`,
          );
          for (const entry of listing.entries) {
            if (entry.kind === "tree") pending.push(entry.path);
            else {
              const file = await read<{ content: string; size: number }>(
                `/api/file?source=commit&revision=${commit.id}&path=${encodeURIComponent(entry.path)}`,
              );
              expect(entry.size).toBe(file.size);
              expect(file.content.endsWith("\n")).toBe(true);
            }
          }
        }
      }
      const results = await read<SearchResult>(
        `/api/search?source=commit&revision=${revision}&query=friend`,
      );
      expect(results.files.length).toBeGreaterThan(0);
      for (const result of results.files) {
        const file = await read<{ content: string }>(
          `/api/file?source=commit&revision=${revision}&path=${encodeURIComponent(result.path)}`,
        );
        const lines = file.content.split("\n").slice(0, -1);
        expect(result.matches).toEqual(
          lines.flatMap((line, index) => (line.includes("friend") ? [index + 1] : [])),
        );
        for (const snippet of result.snippets) {
          const count = snippet.content.split("\n").length - 1;
          expect(snippet.content).toBe(
            `${lines.slice(snippet.startLine - 1, snippet.startLine - 1 + count).join("\n")}\n`,
          );
        }
      }
    }
  });

  it("returns explicit errors and respects aborted requests", async () => {
    for (const [url, code] of [
      ["/api/missing", 404],
      ["/api/file?path=constructor", 404],
      ["/api/tree?revision=missing", 404],
      ["/api/diff?source=missing", 400],
      ["/api/search?source=worktree&query=", 400],
      ["/api/commits?limit=0", 400],
    ] as const) {
      const response = await demoFetch(url);
      expect(response.status).toBe(code);
      expect(await response.json()).toHaveProperty("error");
    }
    expect(
      (await demoFetch(new Request(`${location.origin}/api/repo`, { method: "POST" }))).status,
    ).toBe(405);
    const controller = new AbortController();
    controller.abort();
    await expect(demoFetch("/api/repo", { signal: controller.signal })).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
  });

  it("uses local snapshots independently of the requested revision", async () => {
    for (const url of [
      "/api/file?source=worktree&path=README.md",
      "/api/file?source=index&path=src/greet.ts",
      "/api/search?source=worktree&query=friend",
      "/api/diff?source=worktree",
      "/api/diff?source=staged",
      "/api/diff?source=unstaged",
      "/api/diff?source=untracked",
    ]) {
      expect(await read(`${url}&revision=missing`)).toEqual(await read(url));
    }
  });

  it("delegates external API URLs and non-API URLs to the original fetch", async () => {
    const liveFetch = vi.fn(async () => Response.json({ delegated: true }));
    vi.stubGlobal("fetch", liveFetch);
    vi.resetModules();
    const { demoFetch: isolatedFetch } = await import("./demo");
    for (const url of ["https://example.com/api/repo", "/assets/example.txt"]) {
      const response = await isolatedFetch(url);
      expect(await response.json()).toEqual({ delegated: true });
      expect(liveFetch).toHaveBeenLastCalledWith(url, undefined);
    }
  });
});
