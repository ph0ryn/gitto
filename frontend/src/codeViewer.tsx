import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import nix from "highlight.js/lib/languages/nix";
import "highlight.js/styles/github.css";
import type { LineChange } from "./diffLines";

hljs.registerLanguage("nix", nix);
hljs.registerAliases(["jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["tsx", "mts", "cts"], { languageName: "typescript" });

export function highlightCode(content: string, path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const extension = name.slice(name.lastIndexOf(".") + 1);
  const language = hljs.getLanguage(extension) ? extension : "plaintext";
  const result = hljs.highlight(content, { language });
  if (result.errorRaised) throw result.errorRaised;
  // Preserve CRLF when the highlighted HTML is parsed by the browser.
  return result.value.replaceAll("\r", "&#13;");
}

export default function CodeViewer({
  content,
  path,
  changes = [],
}: {
  content: string;
  path: string;
  changes?: LineChange[];
}) {
  const numbers = useMemo(() => {
    const lines = content.split("\n");
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    return lines.map((_, index) => index + 1).join("\n");
  }, [content]);
  const highlighted = useMemo(() => highlightCode(content, path), [content, path]);

  return (
    <pre className="code-view">
      <span className="line-gutter">
        <span className="line-numbers" aria-hidden="true">
          <span title="Line">{numbers}</span>
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
