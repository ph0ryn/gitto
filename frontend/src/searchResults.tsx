import CodeViewer, { MAX_HIGHLIGHT_BYTES, MAX_SEARCH_HIGHLIGHTS } from "./codeViewer";
import EntryIcon from "./entryIcon";

export type SearchResult = {
  files: Array<{
    path: string;
    matches: number[];
    snippets: Array<{ startLine: number; content: string }>;
  }>;
  truncated: boolean;
  skippedFiles: number;
};

export default function SearchResults({
  result,
  query,
  disabled,
  onOpen,
}: {
  result: SearchResult;
  query: string;
  disabled: boolean;
  onOpen: (path: string, line: number) => void;
}) {
  const count = result.files.reduce((sum, file) => sum + file.matches.length, 0);
  return (
    <div className="search-results">
      <div className="search-summary" role="status">
        <p>
          {count} matching {count === 1 ? "line" : "lines"} in {result.files.length}{" "}
          {result.files.length === 1 ? "file" : "files"}
        </p>
        <p>Case-sensitive text · 2 context lines</p>
        {result.truncated && (
          <p>Results limited to 200 matching lines or 2 MiB. Refine your search.</p>
        )}
        {result.skippedFiles > 0 && (
          <p>
            {result.skippedFiles} {result.skippedFiles === 1 ? "file" : "files"} skipped: binary,
            non-UTF-8, submodule, or over 2 MiB.
          </p>
        )}
      </div>
      {count === 0 && (
        <div className="empty-state">
          <strong>No matches</strong>
          <p>Try another search term. Ignored files are excluded from working-tree searches.</p>
        </div>
      )}
      {result.files.map((file) => (
        <details className="search-file" key={file.path} open>
          <summary>
            <EntryIcon name={file.path} kind="blob" />
            <span className="search-path" title={file.path}>
              {file.path}
            </span>
            <span className="search-count">{file.matches.length}</span>
            <button
              className="search-open"
              disabled={disabled}
              aria-label={`Open ${file.path} at line ${file.matches[0]}`}
              onClick={(event) => {
                event.preventDefault();
                onOpen(file.path, file.matches[0]);
              }}
            >
              Open file
            </button>
          </summary>
          {file.snippets.map((snippet) => (
            <div className="search-snippet" key={snippet.startLine}>
              {new TextEncoder().encode(snippet.content).length > MAX_HIGHLIGHT_BYTES ? (
                <p className="search-summary">Highlighting disabled above 16 KiB.</p>
              ) : snippet.content.split(query, MAX_SEARCH_HIGHLIGHTS + 2).length >
                MAX_SEARCH_HIGHLIGHTS + 1 ? (
                <p className="search-summary">
                  Search highlighting limited to 1,000 occurrences in this snippet.
                </p>
              ) : null}
              <CodeViewer
                content={snippet.content}
                path={file.path}
                startLine={snippet.startLine}
                searchQuery={query}
                disabled={disabled}
                onLineSelect={(line) => onOpen(file.path, line)}
              />
            </div>
          ))}
        </details>
      ))}
    </div>
  );
}
