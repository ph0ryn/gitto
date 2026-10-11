import { useEffect, useRef, useState } from "react";

export type TreeEntry = {
  name: string;
  path: string;
  kind: "tree" | "blob" | "symlink" | "submodule";
  size: number | null;
  local?: boolean;
};

export function mergeLocalEntries(entries: TreeEntry[], paths: string[], parentPath = "") {
  const merged = new Map(entries.map((entry) => [entry.path, entry]));
  const prefix = parentPath ? `${parentPath}/` : "";
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split("/");
    const childPath = `${prefix}${parts[0]}`;
    const kind = parts.length > 1 ? "tree" : "blob";
    const current = merged.get(childPath);
    if (
      !current ||
      (kind === "tree" && current.kind !== "tree") ||
      (kind === "blob" && current.kind === "tree" && !current.local)
    ) {
      merged.set(childPath, {
        name: parts[0],
        path: childPath,
        kind,
        size: null,
        local: true,
      });
    }
  }
  return [...merged.values()];
}

export function EntryIcon({ kind }: { kind: TreeEntry["kind"] }) {
  return <span aria-hidden="true" className={`entry-icon entry-icon-${kind}`} />;
}

export function TreeChevron({ expanded }: { expanded?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`tree-chevron ${expanded === undefined ? "is-leaf" : expanded ? "is-open" : ""}`}
    />
  );
}

type FileTreeProps = {
  entries: TreeEntry[];
  selectedPath?: string;
  decorations?: Map<string, string>;
  localPaths?: string[];
  disabled: boolean;
  loadChildren: (entry: TreeEntry) => Promise<TreeEntry[]>;
  onSelect: (entry: TreeEntry) => void;
  onError: (message: string) => void;
  depth?: number;
  parentPath?: string;
};

export default function FileTree({ entries, depth = 0, parentPath = "", ...props }: FileTreeProps) {
  const sorted = mergeLocalEntries(entries, props.localPaths ?? [], parentPath).sort(
    (a, b) => Number(b.kind === "tree") - Number(a.kind === "tree") || a.name.localeCompare(b.name),
  );
  return (
    <ul className="tree-list">
      {sorted.map((entry) => (
        <FileTreeItem key={entry.path} entry={entry} depth={depth} {...props} />
      ))}
    </ul>
  );
}

function FileTreeItem({
  entry,
  depth,
  ...props
}: Omit<FileTreeProps, "entries" | "depth"> & { entry: TreeEntry; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const folder = entry.kind === "tree";

  async function select() {
    if (!folder) {
      props.onSelect(entry);
      return;
    }
    setExpanded(!expanded);
    if (expanded || children) return;
    setLoading(true);
    try {
      const entries = entry.local ? [] : await props.loadChildren(entry);
      if (mounted.current) setChildren(entries);
    } catch (reason) {
      if (mounted.current) {
        setExpanded(false);
        props.onError(reason instanceof Error ? reason.message : "Could not load the folder.");
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  return (
    <li>
      <button
        className={`tree-row ${props.selectedPath === entry.path ? "is-selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        aria-expanded={folder ? expanded : undefined}
        aria-busy={loading || undefined}
        title={entry.path}
        data-change={props.decorations?.get(entry.path)}
        aria-description={props.decorations?.get(entry.path)}
        disabled={props.disabled || loading}
        onClick={() => void select()}
      >
        <TreeChevron expanded={folder ? expanded : undefined} />
        <EntryIcon kind={entry.kind} />
        <span>{entry.name}</span>
      </button>
      <div
        className="tree-children"
        hidden={!expanded}
        style={{ "--guide-left": `${15 + depth * 16}px` } as React.CSSProperties}
      >
        {loading && (
          <p className="tree-loading" style={{ paddingLeft: 24 + depth * 16 }}>
            Loading…
          </p>
        )}
        {children && (
          <FileTree entries={children} depth={depth + 1} {...props} parentPath={entry.path} />
        )}
      </div>
    </li>
  );
}
