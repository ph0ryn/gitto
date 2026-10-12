import { describe, expect, it } from "vite-plus/test";

import {
  buildChangeDecorations,
  buildChangeTree,
  changeDecoration,
  changeKey,
  type ChangeEntry,
} from "./changeTree";

function entry(path: string, source: ChangeEntry["source"] = "unstaged"): ChangeEntry {
  return { path, source, oldPath: null, status: "modified" };
}

describe("buildChangeTree", () => {
  it("compacts a directory chain while keeping directories before root files", () => {
    const file = entry("frontend/src/app.tsx");
    const rootFile = entry(".gitignore");
    expect(buildChangeTree([rootFile, file])).toEqual([
      {
        name: "frontend/src",
        path: "frontend/src",
        children: [{ name: "app.tsx", path: file.path, entry: file }],
      },
      { name: ".gitignore", path: rootFile.path, entry: rootFile },
    ]);
  });

  it("keeps branching directories and separate staged and unstaged entries", () => {
    const staged = entry("src/main.ts", "staged");
    const unstaged = entry("src/main.ts");
    const nested = entry("src/lib/helper.ts");
    const nodes = buildChangeTree([staged, unstaged, nested]);
    expect(nodes).toEqual([
      {
        name: "src",
        path: "src",
        children: [
          {
            name: "lib",
            path: "src/lib",
            children: [{ name: "helper.ts", path: nested.path, entry: nested }],
          },
          { name: "main.ts", path: staged.path, entry: staged },
          { name: "main.ts", path: unstaged.path, entry: unstaged },
        ],
      },
    ]);
    expect(changeKey(staged)).not.toBe(changeKey(unstaged));
  });
});

describe("change decorations", () => {
  it("maps Git changes to semantic colors", () => {
    expect(
      ["modified", "renamed", "added", "untracked", "deleted", "conflicted"].map(changeDecoration),
    ).toEqual(["modified", "modified", "added", "untracked", "deleted", "conflicted"]);
  });

  it("propagates changes to parent folders with conflicts taking priority", () => {
    const changes = [
      { path: "src/lib/new.ts", status: "untracked" },
      { path: "src/lib/edit.ts", status: "modified" },
      { path: "src/old.ts", status: "deleted" },
      { path: "src/old.ts", status: "conflicted" },
    ];
    const decorations = buildChangeDecorations(changes);
    expect(decorations.get("src")).toBe("conflicted");
    expect(decorations.get("src/lib")).toBe("modified");
    expect(decorations.get("src/lib/new.ts")).toBe("untracked");
    expect(decorations).toEqual(buildChangeDecorations([...changes].reverse()));
  });

  it("decorates both paths of a renamed file", () => {
    const decorations = buildChangeDecorations([
      { path: "new/name.ts", oldPath: "old/name.ts", status: "renamed" },
    ]);
    expect(decorations.get("new/name.ts")).toBe("modified");
    expect(decorations.get("old/name.ts")).toBe("modified");
    expect(decorations.get("old")).toBe("modified");
  });
});
