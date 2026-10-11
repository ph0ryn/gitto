import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import CodeViewer from "./codeViewer";

afterEach(cleanup);

describe("CodeViewer", () => {
  it("omits Git metadata while keeping file names between multiple diffs", () => {
    const patch = [
      "diff --git a/one.ts b/one.ts",
      "index 123..456 100644",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1 +1 @@",
      "--- old text",
      "+++ new text",
      "diff --git a/two.ts b/two.ts",
      "index 789..012 100644",
      "--- a/two.ts",
      "+++ /dev/null",
      "@@ -5 +0,0 @@",
      "-deleted",
      "",
    ].join("\n");
    const { container } = render(<CodeViewer content={patch} path="" diff showFileNames />);

    expect(container.querySelector("code")?.textContent).toBe(
      "one.ts\n@@ -1 +1 @@\n--- old text\n+++ new text\ntwo.ts\n@@ -5 +0,0 @@\n-deleted\n",
    );
    const gutters = container.querySelectorAll(".line-numbers span");
    expect(gutters[0]?.textContent?.split("\n")).toEqual(["", "", "1", "", "", "", "5"]);
    expect(gutters[1]?.textContent?.split("\n")).toEqual(["", "", "", "1", "", "", ""]);
  });

  it("shows old and new diff line numbers across hunks and files", () => {
    const patch = [
      "diff --git a/one.ts b/one.ts",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -10,2 +20,3 @@",
      " context",
      "-old",
      "+new",
      "+extra",
      "@@ -30 +40 @@",
      "---old",
      "+++new",
      "\\ No newline at end of file",
      "diff --git a/two.ts b/two.ts",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -0,0 +1 @@",
      "+added",
      "",
    ].join("\n");
    const { container } = render(<CodeViewer content={patch} path="" diff />);

    const gutters = container.querySelectorAll(".line-numbers span");
    expect(gutters[0]?.textContent?.split("\n")).toEqual([
      "",
      "10",
      "11",
      "",
      "",
      "",
      "30",
      "",
      "",
      "",
      "",
    ]);
    expect(gutters[1]?.textContent?.split("\n")).toEqual([
      "",
      "20",
      "",
      "21",
      "22",
      "",
      "",
      "40",
      "",
      "",
      "1",
    ]);
    expect(container.querySelector("code")?.textContent).toBe(
      "@@ -10,2 +20,3 @@\n context\n-old\n+new\n+extra\n@@ -30 +40 @@\n---old\n+++new\n\\ No newline at end of file\n@@ -0,0 +1 @@\n+added\n",
    );
    expect(container.querySelector(".hljs-addition")).toHaveTextContent("+new");
    expect(container.querySelector(".hljs-deletion")).toHaveTextContent("-old");
  });

  it("keeps unknown files as safe plain text, including Windows newlines", () => {
    const content = '<script>alert("unsafe")</script>\r\n<&>\r\n';
    const { container } = render(<CodeViewer content={content} path="notes.unknown" />);

    expect(container.querySelector("code")?.textContent).toBe(content);
    expect(container.querySelector("code script")).not.toBeInTheDocument();
    expect(container.querySelector("code span")).not.toBeInTheDocument();
    expect(container.querySelector(".line-numbers")).toHaveTextContent("1 2");
  });

  it.each(["", "\n", "\n\n"])("numbers empty lines in %j", (content) => {
    const { container } = render(<CodeViewer content={content} path="empty.txt" />);
    const count = content === "\n\n" ? 2 : 1;
    expect(container.querySelector(".line-numbers")?.textContent).toBe(
      Array.from({ length: count }, (_, index) => index + 1).join("\n"),
    );
    expect(container.querySelector("code")?.textContent).toBe(content);
  });
});
