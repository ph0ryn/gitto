import type { ChangeEntry } from "./changeTree";

export type ViewLocation = {
  revision: string;
  commit: string | null;
  view:
    | { kind: "file"; path: string }
    | { kind: "diff"; source: ChangeEntry["source"]; path?: string }
    | null;
};

export function readViewLocation(): ViewLocation {
  const query = new URLSearchParams(window.location.search);
  const revision = query.get("rev") ?? "HEAD";
  const commit = query.get("commit");
  const kind = query.get("view");
  const path = query.get("path");
  const source = query.get("source");
  if (revision && commit !== "") {
    if (kind === null && path === null && source === null) {
      return { revision, commit, view: null };
    }
    if (kind === "file" && path && source === null) {
      return { revision, commit, view: { kind, path } };
    }
    if (
      kind === "diff" &&
      (source === "staged" ||
        source === "unstaged" ||
        source === "untracked" ||
        source === "commit") &&
      (source === "commit") === (commit !== null) &&
      (path || (path === null && source === "commit"))
    ) {
      return { revision, commit, view: { kind, source, ...(path ? { path } : {}) } };
    }
  }
  throw new Error("Invalid view URL. Open the repository without query parameters and try again.");
}

export function writeViewLocation({ revision, commit, view }: ViewLocation) {
  const url = new URL(window.location.href);
  for (const key of ["rev", "commit", "view", "path", "source"]) url.searchParams.delete(key);
  if (revision !== "HEAD") url.searchParams.set("rev", revision);
  if (commit !== null) url.searchParams.set("commit", commit);
  if (view) {
    url.searchParams.set("view", view.kind);
    if (view.path !== undefined) url.searchParams.set("path", view.path);
    if (view.kind === "diff") url.searchParams.set("source", view.source);
  }
  if (url.href !== window.location.href) window.history.pushState(null, "", url);
}
