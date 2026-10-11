export type DiffLine = {
  text: string;
  oldLine: number | null;
  newLine: number | null;
  anchor: number;
  file: boolean;
};

export type LineChange = {
  line: number;
  endLine?: number;
  kind: "added" | "modified" | "deleted";
  boundary?: boolean;
};

export function parseDiff(content: string): DiffLine[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let oldPath = "";
  return lines.flatMap((text) => {
    if (text.startsWith("diff --git ")) {
      oldLine = null;
      newLine = null;
      return [];
    }
    const row: DiffLine = { text, oldLine: null, newLine: null, anchor: 0, file: false };
    if (oldLine === null && newLine === null) {
      if (text.startsWith("index ")) return [];
      if (text.startsWith("--- ")) {
        oldPath = text.slice(4).replace(/^a\//, "").replace(/\r$/, "");
        return [];
      }
      if (text.startsWith("+++ ")) {
        const path = text.slice(4).replace(/\r$/, "");
        row.text = path === "/dev/null" ? oldPath : path.replace(/^b\//, "");
        row.file = true;
        return [row];
      }
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]) + (hunk[3] === "0" ? 1 : 0);
    } else if (oldLine !== null && newLine !== null) {
      row.anchor = newLine;
      if (text.startsWith("-")) row.oldLine = oldLine++;
      else if (text.startsWith("+")) row.newLine = newLine++;
      else if (text.startsWith(" ")) {
        row.oldLine = oldLine++;
        row.newLine = newLine++;
      }
    }
    return [row];
  });
}

export function lineChanges(patch: string, lineCount: number): LineChange[] {
  const changes: LineChange[] = [];
  let deleted = 0;
  let anchor = 0;
  let added: number[] = [];
  function flush() {
    added.forEach((line, index) => {
      const kind = index < deleted ? "modified" : "added";
      const previous = changes.at(-1);
      if (
        previous &&
        !previous.boundary &&
        previous.kind === kind &&
        (previous.endLine ?? previous.line) === line - 1
      ) {
        previous.endLine = line;
      } else {
        changes.push({ line, kind });
      }
    });
    if (deleted > added.length) {
      const boundary = added.length > 0 ? added[added.length - 1] + 1 : anchor;
      changes.push({
        line: Math.min(Math.max(boundary, 1), lineCount + 1),
        kind: "deleted",
        boundary: true,
      });
    }
    deleted = 0;
    added = [];
  }
  for (const row of parseDiff(patch)) {
    if (row.oldLine !== null && row.newLine === null) {
      if (deleted === 0) anchor = row.anchor;
      deleted++;
    } else if (row.newLine !== null && row.oldLine === null) {
      added.push(row.newLine);
    } else if (!row.text.startsWith("\\ No newline at end of file")) {
      flush();
    }
  }
  flush();
  return changes;
}
