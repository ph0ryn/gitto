import packageJson from "../package.json";

import type { DiffView } from "./diffViewer";
import type { TreeEntry } from "./fileTree";
import type { SearchResult } from "./searchResults";

type Snapshot = Record<string, string>;
const initialId = "a10c001000000000000000000000000000000000";
const headId = "b20c002000000000000000000000000000000000";
const eveningId = "c30c003000000000000000000000000000000000";
const initial: Snapshot = {
  "README.md":
    "# hello-gitto\n\nA small TypeScript greeting app.\n\nRun `pnpm start` to greet a friend.\n",
  "package.json": `${JSON.stringify(
    {
      name: "hello-gitto",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { start: "node src/main.ts" },
    },
    null,
    2,
  )}\n`,
  "src/greet.ts": "export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n",
  "src/main.ts":
    'import { greet } from "./greet.ts";\n\nconsole.log(greet(process.argv[2] ?? "friend"));\n',
};
const head: Snapshot = {
  ...initial,
  "src/greet.ts":
    'export function greet(name: string) {\n  return `Hello, ${name.trim() || "friend"}!`;\n}\n',
  "docs/usage.md": '# Usage\n\nRun `pnpm start Ada`.\n\nAn empty name falls back to "friend".\n',
};
const evening: Snapshot = {
  ...head,
  "src/main.ts":
    'import { greet } from "./greet.ts";\n\nconsole.log(greet(process.argv[2] ?? "evening visitor"));\n',
};
const index: Snapshot = {
  ...head,
  "src/greet.ts":
    'export function greet(name: string) {\n  return `Hi, ${name.trim() || "friend"}!`;\n}\n',
};
const trackedWorktree: Snapshot = {
  ...index,
  "README.md": `${head["README.md"]}\nTry an empty name to see the fallback greeting.\n`,
};
const untracked: Snapshot = {
  "notes/todo.md": "# Next steps\n\n- Add greeting tests\n- Document the shorter greeting\n",
};
const worktree: Snapshot = { ...trackedWorktree, ...untracked };
const snapshots: Record<string, Snapshot> = {
  [initialId]: initial,
  [headId]: head,
  [eveningId]: evening,
};
const commits = [
  { id: eveningId, summary: "feat: add an evening greeting", time: 1791882000, parents: [headId] },
  { id: headId, summary: "feat: handle empty names", time: 1791795600, parents: [initialId] },
  { id: initialId, summary: "feat: add greeting app", time: 1791709200, parents: [] },
].map((commit) => ({
  ...commit,
  shortId: commit.id.slice(0, 7),
  message: commit.summary,
  author: "Gitto Demo",
}));
const branches: Record<string, string> = {
  "refs/heads/main": headId,
  "refs/heads/feature/evening": eveningId,
};

function diff(before: Snapshot, after: Snapshot, selectedPath = ""): DiffView {
  const result: DiffView = { patch: "", files: [], truncated: false };
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const path of paths) {
    if (selectedPath && path !== selectedPath) continue;
    if (before[path] === after[path]) continue;
    const oldLines = before[path]?.split("\n").slice(0, -1) ?? [];
    const newLines = after[path]?.split("\n").slice(0, -1) ?? [];
    let start = 0;
    while (
      start < oldLines.length &&
      start < newLines.length &&
      oldLines[start] === newLines[start]
    )
      start++;
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    const status =
      before[path] === undefined ? "added" : after[path] === undefined ? "deleted" : "modified";
    result.files.push({
      path,
      oldPath: null,
      status,
      additions: newEnd - start,
      deletions: oldEnd - start,
      binary: false,
      tooLarge: false,
    });
    // shortcut: one hunk per small, newline-terminated demo file; use a diff library for arbitrary data.
    result.patch += [
      `diff --git a/${path} b/${path}`,
      `--- ${before[path] === undefined ? "/dev/null" : `a/${path}`}`,
      `+++ ${after[path] === undefined ? "/dev/null" : `b/${path}`}`,
      `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
      ...oldLines.slice(0, start).map((line) => ` ${line}`),
      ...oldLines.slice(start, oldEnd).map((line) => `-${line}`),
      ...newLines.slice(start, newEnd).map((line) => `+${line}`),
      ...newLines.slice(newEnd).map((line) => ` ${line}`),
      "",
    ].join("\n");
  }
  return result;
}

const localComparisons: Record<
  "staged" | "unstaged" | "untracked" | "worktree",
  [Snapshot, Snapshot]
> = {
  staged: [head, index],
  unstaged: [index, trackedWorktree],
  untracked: [{}, untracked],
  worktree: [head, worktree],
};
const status = {
  ...Object.fromEntries(
    (["staged", "unstaged", "untracked"] as const).map((source) => [
      source,
      diff(...localComparisons[source]).files.map(({ path, oldPath, status }) => ({
        path,
        oldPath,
        status: source === "untracked" ? "untracked" : status,
      })),
    ]),
  ),
  conflicts: [],
};

function tree(files: Snapshot, parent: string): TreeEntry[] {
  const entries = new Map<string, TreeEntry>();
  const prefix = parent ? `${parent}/` : "";
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split("/");
    const child = `${prefix}${parts[0]}`;
    entries.set(child, {
      name: parts[0],
      path: child,
      kind: parts.length > 1 ? "tree" : "blob",
      size: parts.length > 1 ? null : new TextEncoder().encode(content).length,
    });
  }
  return [...entries.values()];
}

function search(files: Snapshot, query: string): SearchResult {
  const result: SearchResult = { files: [], truncated: false, skippedFiles: 0 };
  for (const [path, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const lines = content.split("\n").slice(0, -1);
    const matches = lines.flatMap((line, index) => (line.includes(query) ? [index + 1] : []));
    if (matches.length === 0) continue;
    const ranges: Array<{ start: number; end: number }> = [];
    for (const line of matches) {
      const start = Math.max(0, line - 3);
      const end = Math.min(lines.length, line + 2);
      const previous = ranges.at(-1);
      if (previous && start <= previous.end) previous.end = end;
      else ranges.push({ start, end });
    }
    result.files.push({
      path,
      matches,
      snippets: ranges.map(({ start, end }) => ({
        startLine: start + 1,
        content: `${lines.slice(start, end).join("\n")}\n`,
      })),
    });
  }
  return result;
}

const liveFetch = globalThis.fetch;
const error = (message: string, status: number) => Response.json({ error: message }, { status });

export const demoFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    location.origin,
  );
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/"))
    return liveFetch(input, init);
  (init?.signal ?? request?.signal)?.throwIfAborted();
  if ((init?.method ?? request?.method ?? "GET") !== "GET")
    return error("The demo is read-only.", 405);
  if (url.pathname === "/api/repo")
    return Response.json({
      appVersion: packageJson.version,
      name: "hello-gitto",
      path: "/demo/hello-gitto",
      head: "main",
      bare: false,
      branches: Object.keys(branches).map((revision) => ({
        name: revision.slice("refs/heads/".length),
        revision,
      })),
    });
  if (url.pathname === "/api/status") return Response.json(status);
  if (
    !["/api/commits", "/api/tree", "/api/file", "/api/search", "/api/diff"].includes(url.pathname)
  )
    return error("Unknown demo API route.", 404);
  const query = url.searchParams;
  const source = query.get("source") ?? (url.pathname === "/api/file" ? "commit" : "");
  const revision = query.get("revision") ?? "HEAD";
  const usesRevision = ["/api/commits", "/api/tree"].includes(url.pathname) || source === "commit";
  const id = !usesRevision || revision === "HEAD" ? headId : (branches[revision] ?? revision);
  const commit = commits.find((item) => item.id === id);
  if (!commit) return error(`Unknown demo revision: ${revision}`, 404);
  const files = snapshots[id];
  const path = query.get("path") ?? "";
  if (url.pathname === "/api/commits") {
    const history: typeof commits = [];
    let current: typeof commit | undefined = commit;
    while (current) {
      history.push(current);
      const parent: string | undefined = current.parents[0];
      current = commits.find((item) => item.id === parent);
    }
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 50);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return error("Invalid history pagination.", 400);
    return Response.json({
      commits: history.slice(offset, offset + limit),
      hasMore: offset + limit < history.length,
      total: history.length,
    });
  }
  if (url.pathname === "/api/tree") {
    const entries = tree(files, path);
    if (path && entries.length === 0) return error(`Unknown demo directory: ${path}`, 404);
    return Response.json({ revision: id, entries });
  }
  if (url.pathname === "/api/diff") {
    const comparison: [Snapshot, Snapshot] | null =
      source === "commit"
        ? [commit.parents.length ? snapshots[commit.parents[0]] : {}, files]
        : source === "staged" ||
            source === "unstaged" ||
            source === "untracked" ||
            source === "worktree"
          ? localComparisons[source]
          : null;
    if (!comparison) return error(`Unknown demo diff source: ${source}`, 400);
    const view = diff(...comparison, path);
    if (source === "untracked" || source === "worktree") {
      for (const file of view.files) {
        if (file.path in untracked) file.status = "untracked";
      }
    }
    if (query.get("statsOnly") === "true") view.patch = "";
    return Response.json(view);
  }
  const selected =
    source === "worktree"
      ? worktree
      : source === "commit"
        ? files
        : source === "index" && url.pathname === "/api/file"
          ? index
          : null;
  if (!selected) return error(`Unknown demo file source: ${source}`, 400);
  if (url.pathname === "/api/search") {
    const text = query.get("query") ?? "";
    if (!text || new TextEncoder().encode(text).length > 1024 || /[\0\r\n]/.test(text))
      return error("Search text must be a single nonempty line of at most 1024 bytes.", 400);
    return Response.json(search(selected, text));
  }
  if (!Object.hasOwn(selected, path)) return error(`Unknown demo file: ${path}`, 404);
  const content = selected[path];
  return Response.json({
    path,
    kind: "text",
    content,
    size: new TextEncoder().encode(content).length,
  });
};
