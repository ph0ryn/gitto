import { EntryIcon, TreeChevron } from "./fileTree";

export type ChangeEntry = {
  path: string;
  oldPath: string | null;
  status: string;
  source: "staged" | "unstaged" | "untracked";
  stats?: { additions: number; deletions: number; binary: boolean };
};

export type ChangeNode =
  | { name: string; path: string; children: ChangeNode[] }
  | { name: string; path: string; entry: ChangeEntry };

export function changeKey(entry: ChangeEntry) {
  return `${entry.source}:${entry.path}`;
}

export function changeLabel(entry: ChangeEntry) {
  return entry.status === "conflicted"
    ? "Conflict"
    : entry.source === "staged"
      ? "Staged"
      : entry.source === "unstaged"
        ? "Unstaged"
        : "Untracked";
}

export function buildChangeTree(entries: ChangeEntry[]): ChangeNode[] {
  const root: ChangeNode[] = [];
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let nodes = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const path = parts.slice(0, index + 1).join("/");
      let folder = nodes.find((node) => node.path === path && "children" in node);
      if (!folder) {
        folder = { name: parts[index], path, children: [] };
        nodes.push(folder);
      }
      if ("children" in folder) nodes = folder.children;
    }
    nodes.push({ name: parts[parts.length - 1], path: entry.path, entry });
  }

  function compact(nodes: ChangeNode[]): ChangeNode[] {
    return nodes
      .map((node) => {
        if (!("children" in node)) return node;
        while (node.children.length === 1 && "children" in node.children[0]) {
          const child: Extract<ChangeNode, { children: ChangeNode[] }> = node.children[0];
          node = { name: `${node.name}/${child.name}`, path: child.path, children: child.children };
        }
        node.children = compact(node.children);
        return node;
      })
      .sort(
        (a, b) => Number("children" in b) - Number("children" in a) || a.name.localeCompare(b.name),
      );
  }
  return compact(root);
}

export function changeDecoration(status: string) {
  if (status === "conflicted") return "conflicted";
  if (status === "deleted") return "deleted";
  if (status === "added" || status === "untracked") return status;
  return "modified";
}

export function buildChangeDecorations(
  entries: { path: string; oldPath?: string | null; status: string }[],
) {
  const decorations = new Map<string, ReturnType<typeof changeDecoration>>();
  const priority = { untracked: 1, added: 2, modified: 3, deleted: 4, conflicted: 5 };
  for (const entry of entries) {
    const decoration = changeDecoration(entry.status);
    for (const changedPath of entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]) {
      const parts = changedPath.split("/");
      for (let index = 1; index <= parts.length; index++) {
        const path = parts.slice(0, index).join("/");
        const current = decorations.get(path);
        if (!current || priority[decoration] > priority[current]) decorations.set(path, decoration);
      }
    }
  }
  return decorations;
}

export default function ChangeTree({
  nodes,
  disabled,
  selected,
  onSelect,
  decorations,
  depth = 0,
}: {
  nodes: ChangeNode[];
  disabled: boolean;
  selected: string | null;
  onSelect: (entry: ChangeEntry) => void;
  decorations: Map<string, string>;
  depth?: number;
}) {
  return (
    <ul className="tree-list change-tree">
      {nodes.map((node) => (
        <li key={"children" in node ? node.path : changeKey(node.entry)}>
          {"children" in node ? (
            <details open>
              <summary
                className="tree-row"
                style={{ paddingLeft: 8 + depth * 16 }}
                title={node.path}
                data-change={decorations.get(node.path)}
              >
                <TreeChevron expanded />
                <EntryIcon kind="tree" />
                <span>{node.name}</span>
              </summary>
              <div
                className="tree-children"
                style={{ "--guide-left": `${15 + depth * 16}px` } as React.CSSProperties}
              >
                <ChangeTree
                  nodes={node.children}
                  depth={depth + 1}
                  disabled={disabled}
                  selected={selected}
                  onSelect={onSelect}
                  decorations={decorations}
                />
              </div>
            </details>
          ) : (
            <button
              className={`tree-row change-row ${selected === changeKey(node.entry) ? "is-selected" : ""}`}
              style={{ paddingLeft: 8 + depth * 16 }}
              title={node.path}
              data-change={changeDecoration(node.entry.status)}
              aria-label={`${node.path} diff (${changeLabel(node.entry)} · ${node.entry.status})`}
              aria-pressed={selected === changeKey(node.entry)}
              disabled={disabled}
              onClick={() => onSelect(node.entry)}
            >
              <TreeChevron />
              <span className="status-dot" data-status={node.entry.status} aria-hidden="true" />
              <span className="tree-name">{node.name}</span>
              {node.entry.source === "staged" && (
                <small className="change-source" title="Staged">
                  S
                </small>
              )}
              {node.entry.status === "conflicted" && (
                <small className="change-source" title="Conflict">
                  !
                </small>
              )}
              {node.entry.stats &&
                (node.entry.stats.binary ? (
                  <small className="change-binary">Binary</small>
                ) : (
                  <span className="change-stats">
                    <span className="diff-add">+ {node.entry.stats.additions}</span>
                    <span className="diff-del">− {node.entry.stats.deletions}</span>
                  </span>
                ))}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
