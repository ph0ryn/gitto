import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import nix from "highlight.js/lib/languages/nix";
import "highlight.js/styles/github.css";
import { parseDiff, type LineChange } from "./diffLines";

hljs.registerLanguage("nix", nix);
hljs.registerAliases(["jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["tsx", "mts", "cts"], { languageName: "typescript" });

function prepareView(content: string, diff: boolean, showFileNames: boolean) {
  const lines = content.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (!diff) return { content, numbers: [lines.map((_, index) => index + 1).join("\n")] };
  const rows = parseDiff(content).filter((row) => showFileNames || !row.file);
  return {
    content:
      rows.map((row) => row.text).join("\n") +
      (rows.length > 0 && content.endsWith("\n") ? "\n" : ""),
    numbers: (["oldLine", "newLine"] as const).map((column) =>
      rows.map((row) => row[column] ?? "").join("\n"),
    ),
  };
}

export default function CodeViewer({
  content,
  path,
  diff = false,
  showFileNames = false,
  changes = [],
}: {
  content: string;
  path: string;
  diff?: boolean;
  showFileNames?: boolean;
  changes?: LineChange[];
}) {
  const view = useMemo(
    () => prepareView(content, diff, showFileNames),
    [content, diff, showFileNames],
  );
  const highlighted = useMemo(() => {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const extension = name.slice(name.lastIndexOf(".") + 1);
    const language = diff ? "diff" : hljs.getLanguage(extension) ? extension : "plaintext";
    const result = hljs.highlight(view.content, { language });
    if (result.errorRaised) throw result.errorRaised;
    // Preserve CRLF when the highlighted HTML is parsed by the browser.
    return result.value.replaceAll("\r", "&#13;");
  }, [view.content, path, diff]);

  return (
    <pre className={`code-view${diff ? " patch-view" : ""}`}>
      <span className="line-gutter">
        <span className="line-numbers" aria-hidden="true">
          {view.numbers.map((column, index) => (
            <span key={index} title={diff ? (index === 0 ? "Old line" : "New line") : "Line"}>
              {column}
            </span>
          ))}
        </span>
        {changes.map((change) => {
          const range = change.endLine && change.endLine > change.line;
          const label = `${change.kind[0].toUpperCase()}${change.kind.slice(1)} ${change.boundary ? "before line" : range ? "lines" : "line"} ${change.line}${range ? `–${change.endLine}` : ""}`;
          return (
            <span
              key={`${change.line}:${change.kind}`}
              className={`line-change ${change.kind}${change.boundary ? " boundary" : ""}`}
              style={{
                top: `${change.line - 1}lh`,
                height: change.boundary
                  ? undefined
                  : `${(change.endLine ?? change.line) - change.line + 1}lh`,
              }}
              role="img"
              aria-label={label}
              title={label}
            />
          );
        })}
      </span>
      {/* Only highlight.js output is inserted; it escapes the source text. */}
      <code dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  );
}
