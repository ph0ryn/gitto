import hljs from "highlight.js/lib/common";
import nix from "highlight.js/lib/languages/nix";
import { useEffect, useMemo, useRef } from "react";
import "highlight.js/styles/github.css";

import type { LineChange } from "./diffLines";

hljs.registerLanguage("nix", nix);
hljs.registerAliases(["jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["tsx", "mts", "cts"], { languageName: "typescript" });

// shortcut: synchronous highlighting is limited to 16 KiB, revisit after moving work off the UI thread.
export const MAX_HIGHLIGHT_BYTES = 16 * 1024;
export const MAX_SEARCH_HIGHLIGHTS = 1000;

export function highlightCode(content: string, path: string, enabled = true) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const extension = name.slice(name.lastIndexOf(".") + 1);
  const language =
    enabled &&
    new TextEncoder().encode(content).length <= MAX_HIGHLIGHT_BYTES &&
    hljs.getLanguage(extension)
      ? extension
      : "plaintext";
  const result = hljs.highlight(content, { language });
  if (result.errorRaised) throw result.errorRaised;
  // Preserve CRLF when the highlighted HTML is parsed by the browser.
  return result.value.replaceAll("\r", "&#13;");
}

function highlightMatches(html: string, content: string, query: string) {
  // shortcut: bound search highlighting too, revisit after rendering large excerpts off the UI thread.
  if (!query || new TextEncoder().encode(content).length > MAX_HIGHLIGHT_BYTES) return html;
  const ranges: Array<[number, number]> = [];
  for (
    let start = content.indexOf(query);
    start !== -1 && ranges.length < MAX_SEARCH_HIGHLIGHTS;
    start = content.indexOf(query, start + query.length)
  ) {
    ranges.push([start, start + query.length]);
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let offset = 0;
  for (const node of nodes) {
    const text = node.data;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start >= offset + text.length || end <= offset) continue;
      const from = Math.max(0, start - offset);
      const to = Math.min(text.length, end - offset);
      fragment.append(text.slice(cursor, from));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(from, to);
      fragment.append(mark);
      cursor = to;
    }
    if (cursor > 0) {
      fragment.append(text.slice(cursor));
      node.replaceWith(fragment);
    }
    offset += text.length;
  }
  return template.innerHTML.replaceAll("\r", "&#13;");
}

export default function CodeViewer({
  content,
  path,
  changes = [],
  startLine = 1,
  searchQuery = "",
  focusLine,
  onLineSelect,
  disabled = false,
}: {
  content: string;
  path: string;
  changes?: LineChange[];
  startLine?: number;
  searchQuery?: string;
  focusLine?: number;
  onLineSelect?: (line: number) => void;
  disabled?: boolean;
}) {
  const target = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: "center" });
  }, [content, path, focusLine]);
  const numbers = useMemo(() => {
    const lines = content.split("\n");
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    return lines.map((_, index) => index + startLine).join("\n");
  }, [content, startLine]);
  const highlighted = useMemo(
    () => highlightMatches(highlightCode(content, path), content, searchQuery),
    [content, path, searchQuery],
  );

  return (
    <pre className="code-view">
      {focusLine !== undefined && (
        <span
          ref={target}
          className="search-result-line"
          style={{ top: `${focusLine - startLine}lh` }}
          role="img"
          aria-label={`Search result line ${focusLine}`}
        />
      )}
      <span className="line-gutter">
        <span className="line-numbers" aria-hidden={!onLineSelect}>
          <span title="Line">
            {onLineSelect
              ? numbers.split("\n").map((line) => (
                  <button
                    key={line}
                    disabled={disabled}
                    aria-label={`Go to ${path} line ${line}`}
                    onClick={() => onLineSelect(Number(line))}
                  >
                    {line}
                  </button>
                ))
              : numbers}
          </span>
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
