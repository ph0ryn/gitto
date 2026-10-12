import "@testing-library/jest-dom/vitest";
import { icons } from "@iconify-json/catppuccin";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import FileTree, { type TreeEntry } from "./fileTree";

const folder: TreeEntry = { name: "src", path: "src", kind: "tree", size: null };

function file(name: string): TreeEntry {
  return { name, path: `src/${name}`, kind: "blob", size: 1 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function renderTree(
  loadChildren: (entry: TreeEntry) => Promise<TreeEntry[]>,
  refreshVersion = 0,
  entries = [folder],
) {
  return render(
    <FileTree
      entries={entries}
      refreshVersion={refreshVersion}
      disabled={false}
      loadChildren={loadChildren}
      onSelect={vi.fn()}
      onError={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FileTree refresh", () => {
  it("renders Catppuccin file types and switches the folder artwork when expanded", async () => {
    renderTree(vi.fn().mockResolvedValue([]), 0, [folder, file("app.tsx")]);
    const fileIcon = screen
      .getByRole("button", { name: "app.tsx" })
      .querySelector("svg.entry-icon");
    expect(fileIcon).toHaveAttribute("aria-hidden", "true");
    expect(fileIcon).toHaveAttribute("viewBox", "0 0 16 16");
    expect(fileIcon?.querySelector("path")).toHaveAttribute(
      "d",
      icons.icons["typescript-react"].body.match(/ d="([^"]+)"/)?.[1],
    );

    const folderButton = screen.getByRole("button", { name: "src" });
    const closedArtwork = folderButton.querySelector("svg.entry-icon")?.innerHTML;
    expect(closedArtwork).toBeTruthy();
    await userEvent.setup().click(folderButton);
    expect(folderButton.querySelector("svg.entry-icon")?.innerHTML).not.toBe(closedArtwork);
    expect(folderButton.querySelector("svg.entry-icon path")).toHaveAttribute(
      "d",
      icons.icons["folder-src-open"].body.match(/ d="([^"]+)"/)?.[1],
    );
  });

  it("exposes the current file without marking expandable folders as current", () => {
    const entries = [folder, file("first.ts"), file("second.ts")];
    const props = {
      entries,
      disabled: false,
      loadChildren: vi.fn(),
      onSelect: vi.fn(),
      onError: vi.fn(),
    };
    const view = render(<FileTree {...props} selectedPath="src/first.ts" />);

    expect(screen.getByRole("button", { name: "first.ts" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("button", { name: "src" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "second.ts" })).not.toHaveAttribute("aria-current");

    view.rerender(<FileTree {...props} selectedPath="src/second.ts" />);
    expect(screen.getByRole("button", { name: "first.ts" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "second.ts" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("reloads expanded folders while keeping the old children until the update completes", async () => {
    const initial = deferred<TreeEntry[]>();
    const refreshed = deferred<TreeEntry[]>();
    const loadChildren = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);
    const user = userEvent.setup();
    const view = renderTree(loadChildren);

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(screen.getByText("Loading…")).toBeVisible();
    expect(screen.getByRole("button", { name: "src" })).toBeDisabled();
    await act(async () => initial.resolve([file("old.ts")]));
    const oldFile = screen.getByRole("button", { name: "old.ts" });
    expect(oldFile).toBeVisible();

    view.rerender(
      <FileTree
        entries={[folder]}
        refreshVersion={1}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(loadChildren).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "old.ts" })).toBe(oldFile);
    expect(oldFile).toBeVisible();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-expanded", "true");

    await act(async () => refreshed.resolve([file("new.ts")]));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "old.ts" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "new.ts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-expanded", "true");
  });

  it("allows collapsing a folder during refresh and ignores the cancelled result", async () => {
    const refreshed = deferred<TreeEntry[]>();
    const loadChildren = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockResolvedValueOnce([file("cached.ts")])
      .mockReturnValueOnce(refreshed.promise)
      .mockResolvedValueOnce([file("latest.ts")]);
    const props = {
      entries: [folder],
      disabled: false,
      loadChildren,
      onSelect: vi.fn(),
      onError: vi.fn(),
    };
    const user = userEvent.setup();
    const view = render(<FileTree {...props} />);
    const folderButton = screen.getByRole("button", { name: "src" });

    await user.click(folderButton);
    expect(await screen.findByRole("button", { name: "cached.ts" })).toBeVisible();
    view.rerender(<FileTree {...props} refreshVersion={1} />);
    await user.click(folderButton);
    expect(folderButton).toHaveAttribute("aria-expanded", "false");

    await act(async () => refreshed.resolve([file("cancelled.ts")]));
    expect(screen.queryByText("cancelled.ts")).not.toBeInTheDocument();
    await user.click(folderButton);
    expect(await screen.findByRole("button", { name: "latest.ts" })).toBeVisible();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("does not duplicate a pending refresh and reloads on the next refresh", async () => {
    const pending = deferred<TreeEntry[]>();
    const next = deferred<TreeEntry[]>();
    const loadChildren = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockResolvedValueOnce([file("initial.ts")])
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(next.promise);
    const user = userEvent.setup();
    const view = renderTree(loadChildren);

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "initial.ts" })).toBeVisible();

    view.rerender(
      <FileTree
        entries={[folder]}
        refreshVersion={1}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );
    view.rerender(
      <FileTree
        entries={[folder]}
        refreshVersion={2}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(loadChildren).toHaveBeenCalledTimes(2);

    await act(async () => pending.resolve([file("latest.ts")]));
    expect(await screen.findByRole("button", { name: "latest.ts" })).toBeVisible();
    view.rerender(
      <FileTree
        entries={[folder]}
        refreshVersion={3}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(loadChildren).toHaveBeenCalledTimes(3);
    await act(async () => next.resolve([file("newest.ts")]));
    expect(await screen.findByRole("button", { name: "newest.ts" })).toBeVisible();
  });

  it("reloads and ignores old results when the revision loader changes", async () => {
    const oldRevision = deferred<TreeEntry[]>();
    const newRevision = deferred<TreeEntry[]>();
    const initialLoader = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockResolvedValue([file("initial.ts")]);
    const oldLoader = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockReturnValue(oldRevision.promise);
    const newLoader = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockReturnValue(newRevision.promise);
    const user = userEvent.setup();
    const view = renderTree(initialLoader);

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "initial.ts" })).toBeVisible();
    view.rerender(
      <FileTree
        entries={[folder]}
        disabled={false}
        loadChildren={oldLoader}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );
    view.rerender(
      <FileTree
        entries={[folder]}
        disabled={false}
        loadChildren={newLoader}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(oldLoader).toHaveBeenCalledTimes(1);
    expect(newLoader).toHaveBeenCalledTimes(1);

    await act(async () => oldRevision.resolve([file("old-revision.ts")]));
    expect(screen.queryByRole("button", { name: "old-revision.ts" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "initial.ts" })).toBeVisible();
    await act(async () => newRevision.resolve([file("new-revision.ts")]));
    expect(await screen.findByRole("button", { name: "new-revision.ts" })).toBeVisible();
  });

  it("reloads a cached folder when it is reopened after a refresh", async () => {
    const refreshed = deferred<TreeEntry[]>();
    const loadChildren = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockResolvedValueOnce([file("old.ts")])
      .mockReturnValueOnce(refreshed.promise);
    const user = userEvent.setup();
    const view = renderTree(loadChildren);

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "old.ts" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "src" }));
    view.rerender(
      <FileTree
        entries={[folder]}
        refreshVersion={1}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(loadChildren).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(loadChildren).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "old.ts" })).toBeVisible();
    await act(async () => refreshed.resolve([file("latest.ts")]));
    expect(await screen.findByRole("button", { name: "latest.ts" })).toBeVisible();
  });

  it("reloads when an expanded local folder becomes committed", async () => {
    const committed = deferred<TreeEntry[]>();
    const loadChildren = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockReturnValue(committed.promise);
    const user = userEvent.setup();
    const view = render(
      <FileTree
        entries={[{ ...folder, local: true }]}
        localPaths={["src/local.ts"]}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "local.ts" })).toBeVisible();
    view.rerender(
      <FileTree
        entries={[folder]}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(loadChildren).toHaveBeenCalledTimes(1);
    await act(async () => committed.resolve([file("committed.ts")]));
    expect(await screen.findByRole("button", { name: "committed.ts" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "local.ts" })).not.toBeInTheDocument();
  });

  it("resets folder state when a path changes from a tree to a blob", async () => {
    const loadChildren = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockResolvedValue([file("old.ts")]);
    const user = userEvent.setup();
    const view = renderTree(loadChildren);

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "old.ts" })).toBeVisible();
    view.rerender(
      <FileTree
        entries={[{ ...folder, kind: "blob", size: 1 }]}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const fileEntry = screen.getByRole("button", { name: "src" });
    expect(fileEntry).not.toHaveAttribute("aria-expanded");
    expect(screen.queryByRole("button", { name: "old.ts" })).not.toBeInTheDocument();
  });

  it("keeps cached children and retries a failed refresh automatically", async () => {
    const failedRefresh = deferred<TreeEntry[]>();
    const retry = deferred<TreeEntry[]>();
    const onError = vi.fn();
    const loadChildren = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockResolvedValueOnce([file("cached.ts")])
      .mockReturnValueOnce(failedRefresh.promise)
      .mockReturnValueOnce(retry.promise);
    const user = userEvent.setup();
    const view = render(
      <FileTree
        entries={[folder]}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={onError}
      />,
    );

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "cached.ts" })).toBeVisible();
    view.rerender(
      <FileTree
        entries={[folder]}
        refreshVersion={1}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={onError}
      />,
    );
    await act(async () => failedRefresh.reject(new Error("temporary")));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("temporary"));
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "cached.ts" })).toBeVisible();

    view.rerender(
      <FileTree
        entries={[folder]}
        refreshVersion={2}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={onError}
      />,
    );
    expect(loadChildren).toHaveBeenCalledTimes(3);
    await act(async () => retry.resolve([file("retried.ts")]));
    expect(await screen.findByRole("button", { name: "retried.ts" })).toBeVisible();
  });

  it("keeps an initially failed folder open for the next automatic retry", async () => {
    const initial = deferred<TreeEntry[]>();
    const retry = deferred<TreeEntry[]>();
    const onError = vi.fn();
    const loadChildren = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(retry.promise);
    const user = userEvent.setup();
    const view = render(
      <FileTree
        entries={[folder]}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={onError}
      />,
    );

    await user.click(screen.getByRole("button", { name: "src" }));
    await act(async () => initial.reject(new Error("initial failure")));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("initial failure"));
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-expanded", "true");

    view.rerender(
      <FileTree
        entries={[folder]}
        refreshVersion={1}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={onError}
      />,
    );
    expect(loadChildren).toHaveBeenCalledTimes(2);
    await act(async () => retry.resolve([file("retried.ts")]));
    expect(await screen.findByRole("button", { name: "retried.ts" })).toBeVisible();
  });

  it("ignores a late refresh error after the folder is replaced", async () => {
    const refresh = deferred<TreeEntry[]>();
    const onError = vi.fn();
    const loadChildren = vi
      .fn<(entry: TreeEntry) => Promise<TreeEntry[]>>()
      .mockResolvedValueOnce([file("initial.ts")])
      .mockReturnValueOnce(refresh.promise);
    const user = userEvent.setup();
    const view = render(
      <FileTree
        entries={[folder]}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={onError}
      />,
    );

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "initial.ts" })).toBeVisible();
    view.rerender(
      <FileTree
        entries={[folder]}
        refreshVersion={1}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={onError}
      />,
    );
    view.rerender(
      <FileTree
        entries={[{ name: "docs", path: "docs", kind: "tree", size: null }]}
        refreshVersion={2}
        disabled={false}
        loadChildren={loadChildren}
        onSelect={vi.fn()}
        onError={onError}
      />,
    );
    await act(async () => refresh.reject(new Error("old revision")));

    expect(onError).not.toHaveBeenCalled();
    expect(within(document.body).getByRole("button", { name: "docs" })).toBeVisible();
  });
});
