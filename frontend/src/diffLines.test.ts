import { describe, expect, it } from "vite-plus/test";
import { lineChanges } from "./diffLines";

describe("lineChanges", () => {
  it("marks replacements, extra additions, and deletions at their surviving boundary", () => {
    const patch = [
      "@@ -1,4 +1,4 @@",
      " unchanged",
      "-old",
      "+new",
      "+extra",
      " context",
      "-removed",
      "@@ -10 +10,0 @@",
      "-last",
    ].join("\n");
    expect(lineChanges(patch, 9)).toEqual([
      { line: 2, kind: "modified" },
      { line: 3, kind: "added" },
      { line: 5, kind: "deleted", boundary: true },
      { line: 10, kind: "deleted", boundary: true },
    ]);
  });

  it("anchors deletion of all content at the first line", () => {
    expect(lineChanges("@@ -1,2 +0,0 @@\n-one\n-two\n", 1)).toEqual([
      { line: 1, kind: "deleted", boundary: true },
    ]);
  });

  it("anchors a zero-length new hunk after its preceding line", () => {
    expect(lineChanges("@@ -5 +4,0 @@\n-deleted\n", 8)).toEqual([
      { line: 5, kind: "deleted", boundary: true },
    ]);
  });

  it("groups consecutive added lines into one marker", () => {
    expect(lineChanges("@@ -0,0 +1,3 @@\n+one\n+two\n+three\n", 3)).toEqual([
      { line: 1, endLine: 3, kind: "added" },
    ]);
  });
});
