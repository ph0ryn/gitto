import { useMemo, type CSSProperties } from "react";

import { highlightCode, MAX_HIGHLIGHT_BYTES } from "./codeViewer";
import { parseDiff, type DiffLine } from "./diffLines";

export type DiffFile = {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;
};
export type DiffView = { patch: string; files: DiffFile[]; truncated: boolean };

// shortcut: render at most 1,000 source lines, revisit when the diff rows are virtualized.
const MAX_DIFF_LINES = 1000;

function highlightLines(lines: string[], path: string, enabled: boolean) {
  const spans: string[] = [];
  return highlightCode(lines.join("\n"), path, enabled)
    .split("\n")
    .map((line) => {
      const prefix = spans.join("");
      for (const tag of line.matchAll(/<span\b[^>]*>|<\/span>/g)) {
        if (tag[0] === "</span>") spans.pop();
        else spans.push(tag[0]);
      }
      // Each table row must close and reopen syntax spans crossing a newline.
      return prefix + line + "</span>".repeat(spans.length);
    });
}

function prepareDiff(view: DiffView) {
  const groups: { path: string; rows: DiffLine[] }[] = [];
  const highlighting = new TextEncoder().encode(view.patch).length <= MAX_HIGHLIGHT_BYTES;
  let lines = 0;
  let linesTruncated = false;
  for (const row of parseDiff(view.patch)) {
    if (row.oldLine !== null || row.newLine !== null) {
      if (lines === MAX_DIFF_LINES) {
        linesTruncated = true;
        break;
      }
      lines++;
    }
    if (row.file) groups.push({ path: row.text, rows: [] });
    else if (
      row.oldLine !== null ||
      row.newLine !== null ||
      row.text.startsWith("@@ ") ||
      row.text.startsWith("\\ No newline at end of file")
    ) {
      if (groups.length === 0) groups.push({ path: view.files[0]?.path ?? "Diff", rows: [] });
      groups[groups.length - 1].rows.push(row);
    }
  }
  const prepared = groups
    .filter(
      ({ rows }) =>
        !(view.truncated || linesTruncated) ||
        rows.some((row) => row.oldLine !== null || row.newLine !== null),
    )
    .map(({ path, rows }) => {
      const hunks: DiffLine[][] = [];
      for (const row of rows) {
        if (hunks.length === 0 || row.text.startsWith("@@ ")) hunks.push([]);
        hunks[hunks.length - 1].push(row);
      }
      return {
        path,
        digits: rows.reduce(
          (digits, row) =>
            Math.max(digits, String(row.oldLine ?? "").length, String(row.newLine ?? "").length),
          3,
        ),
        rows: hunks.flatMap((hunk) => {
          const old = highlightLines(
            hunk.filter((row) => row.oldLine !== null).map((row) => row.text.slice(1)),
            path,
            highlighting,
          );
          const next = highlightLines(
            hunk.filter((row) => row.newLine !== null).map((row) => row.text.slice(1)),
            path,
            highlighting,
          );
          let oldIndex = 0;
          let newIndex = 0;
          return hunk.map((row) => {
            const oldHtml = row.oldLine === null ? null : old[oldIndex++];
            const newHtml = row.newLine === null ? null : next[newIndex++];
            return { ...row, html: newHtml ?? oldHtml };
          });
        }),
      };
    });
  return { groups: prepared, highlighting, linesTruncated };
}

export default function DiffViewer({ view }: { view: DiffView }) {
  const { groups, highlighting, linesTruncated } = useMemo(() => prepareDiff(view), [view]);
  const truncated = view.truncated || linesTruncated;
  const specialFiles = view.files.filter(
    (file) =>
      file.binary ||
      file.tooLarge ||
      file.status.includes("submodule") ||
      file.status.includes("conflicted"),
  );
  const noTextFiles = truncated
    ? []
    : view.files.filter(
        (file) => !specialFiles.includes(file) && !groups.some((group) => group.path === file.path),
      );
  return (
    <div className="diff-view">
      {(truncated || (!highlighting && groups.length > 0)) && (
        <div className="diff-summary">
          {truncated && <span className="diff-truncated">Truncated</span>}
          {linesTruncated && <span>Showing the first 1,000 lines.</span>}
          {!highlighting && groups.length > 0 && <span>Syntax highlighting disabled</span>}
        </div>
      )}
      {specialFiles.length > 0 && (
        <ul className="diff-file-list">
          {specialFiles.map((file) => (
            <li key={file.path}>
              <span>{file.path}</span>
              <small>
                {file.status.includes("submodule")
                  ? "Submodule conflict"
                  : file.tooLarge
                    ? "Diff exceeds the 2 MiB preview limit"
                    : file.status.includes("conflicted")
                      ? "Conflict (ours → working tree)"
                      : "Binary diff"}
              </small>
            </li>
          ))}
        </ul>
      )}
      {groups.map((group) => {
        const file = view.files.find(
          (file) => file.path === group.path || file.oldPath === group.path,
        );
        return (
          <section key={group.path} aria-label={group.path}>
            {(groups.length > 1 || (file?.oldPath && file.oldPath !== file.path)) && (
              <h3 className="diff-file-heading">
                {file?.oldPath && file.oldPath !== file.path
                  ? `${file.oldPath} → ${file.path}`
                  : group.path}
              </h3>
            )}
            {group.rows.length > 0 ? (
              <table
                className="diff-table"
                aria-label={`${group.path} diff`}
                style={{ "--line-width": `calc(${group.digits}ch + 16px)` } as CSSProperties}
              >
                <thead className="visually-hidden">
                  <tr>
                    <th scope="col">Old line</th>
                    <th scope="col">New line</th>
                    <th scope="col">Change</th>
                    <th scope="col">Code</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row, index) => {
                    if (row.html === null) {
                      if (row.text.startsWith("@@ "))
                        return index === 0 ? null : (
                          <tr key={index} className="diff-gap" aria-label="Unchanged lines omitted">
                            <td colSpan={3} title="Unchanged lines omitted">
                              …
                            </td>
                            <td />
                          </tr>
                        );
                      return (
                        <tr key={index} className="diff-note">
                          <td colSpan={3} />
                          <td>No newline at end of file</td>
                        </tr>
                      );
                    }
                    const kind =
                      row.oldLine === null ? "added" : row.newLine === null ? "deleted" : "context";
                    const label =
                      kind === "context"
                        ? `Line ${row.oldLine} → ${row.newLine}`
                        : `${kind === "added" ? "Added" : "Deleted"} line ${row.newLine ?? row.oldLine}`;
                    return (
                      <tr key={index} aria-label={label}>
                        <td className={`diff-old diff-gutter ${kind}`} title="Old line">
                          {row.oldLine}
                        </td>
                        <td className={`diff-new diff-gutter ${kind}`} title="New line">
                          {row.newLine}
                        </td>
                        <td className={`diff-sign diff-gutter ${kind}`} aria-hidden="true">
                          {kind === "added" ? "+" : kind === "deleted" ? "−" : ""}
                        </td>
                        <td className="diff-code">
                          <code dangerouslySetInnerHTML={{ __html: row.html }} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="diff-message">No text changes.</p>
            )}
          </section>
        );
      })}
      {noTextFiles.map((file) => (
        <p key={file.path} className="diff-message">
          {file.oldPath && file.oldPath !== file.path
            ? `${file.oldPath} → ${file.path}`
            : file.path}
          : No text changes.
        </p>
      ))}
      {!view.patch && view.files.length === 0 && <p className="diff-message">No diff.</p>}
    </div>
  );
}
