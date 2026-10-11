import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import DiffViewer, { type DiffFile } from "./diffViewer";

afterEach(cleanup);

function file(path: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    ...overrides,
  };
}

describe("DiffViewer", () => {
  it("resets syntax context across omitted source ranges", () => {
    render(
      <DiffViewer
        view={{
          patch:
            "@@ -1 +1 @@\n-/* old\n+/* new\n@@ -10 +10 @@\n-const later = 1;\n+const later = 2;\n",
          files: [file("main.ts")],
          truncated: false,
        }}
      />,
    );
    const later = screen.getByRole("row", { name: "Added line 10" });
    expect(later.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(later.querySelector(".hljs-comment")).not.toBeInTheDocument();
  });

  it("puts addition signs in the gutter and preserves source syntax and blank lines", () => {
    const { container } = render(
      <DiffViewer
        view={{
          patch:
            "diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 000..123\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,3 @@\n+const value = 1;\n+\n+console.log(value);\n",
          files: [file("new.ts", { status: "added", additions: 3, deletions: 0 })],
          truncated: false,
        }}
      />,
    );
    const table = screen.getByRole("table", { name: "new.ts diff" });
    const added = within(table).getByRole("row", { name: "Added line 1" });
    expect(added.querySelector("code")?.textContent).toBe("const value = 1;");
    expect(added.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(added.querySelector(".diff-sign")).toHaveTextContent("+");
    expect(
      within(table).getByRole("row", { name: "Added line 2" }).querySelector("code")?.textContent,
    ).toBe("");
    expect(container).not.toHaveTextContent("new file mode");
    expect(container).not.toHaveTextContent("@@");
    expect(container.querySelector(".hljs-addition")).not.toBeInTheDocument();
    expect(container.querySelector(".diff-summary")).not.toBeInTheDocument();
  });

  it("keeps file boundaries, hunk line numbers, header-like source, and newline notices", () => {
    render(
      <DiffViewer
        view={{
          patch: [
            "diff --git a/one.txt b/one.txt",
            "--- a/one.txt",
            "+++ b/one.txt",
            "@@ -10,2 +20,3 @@",
            " context",
            "--- old text",
            "+++ new text",
            "+extra",
            "@@ -30 +40 @@",
            "-old",
            "+new",
            "\\ No newline at end of file",
            "diff --git a/two.txt b/two.txt",
            "--- a/two.txt",
            "+++ /dev/null",
            "@@ -5 +0,0 @@",
            "-deleted",
            "",
          ].join("\n"),
          files: [file("one.txt"), file("two.txt", { status: "deleted" })],
          truncated: false,
        }}
      />,
    );
    const first = screen.getByRole("table", { name: "one.txt diff" });
    expect(within(first).getByRole("row", { name: "Line 10 → 20" })).toHaveTextContent("context");
    expect(
      within(first).getByRole("row", { name: "Deleted line 11" }).querySelector("code")
        ?.textContent,
    ).toBe("-- old text");
    expect(
      within(first).getByRole("row", { name: "Added line 21" }).querySelector("code")?.textContent,
    ).toBe("++ new text");
    expect(within(first).getByRole("row", { name: "Unchanged lines omitted" })).toBeInTheDocument();
    expect(within(first).getByRole("row", { name: "Deleted line 30" })).toHaveTextContent("old");
    expect(within(first).getByRole("row", { name: "Added line 40" })).toHaveTextContent("new");
    expect(within(first).getByText("No newline at end of file")).toBeInTheDocument();
    expect(
      within(screen.getByRole("table", { name: "two.txt diff" })).getByRole("row", {
        name: "Deleted line 5",
      }),
    ).toHaveTextContent("deleted");
    expect(screen.getByRole("heading", { name: "two.txt" })).toBeInTheDocument();
  });

  it("keeps multiline syntax spans balanced without running HTML or losing CRLF", () => {
    const { container } = render(
      <DiffViewer
        view={{
          patch: "@@ -1,2 +1,2 @@\n-/* old\n- */\n+/* new\r\n+<script>bad()</script> */\r\n",
          files: [file("main.ts")],
          truncated: false,
        }}
      />,
    );
    const added = screen.getByRole("row", { name: "Added line 2" });
    expect(added.querySelector("code")?.textContent).toBe("<script>bad()</script> */\r");
    expect(added.querySelector(".hljs-comment")).toHaveTextContent("bad()");
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(
      screen.getByRole("row", { name: "Deleted line 2" }).querySelector(".hljs-comment"),
    ).toHaveTextContent("*/");
  });

  it("shows metadata-only renames and binary states without raw patch metadata", () => {
    render(
      <DiffViewer
        view={{
          patch:
            "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
          files: [
            file("new.ts", { oldPath: "old.ts", status: "renamed", additions: 0, deletions: 0 }),
            file("image.png", { binary: true }),
          ],
          truncated: false,
        }}
      />,
    );
    expect(screen.getByText("old.ts → new.ts: No text changes.")).toBeInTheDocument();
    expect(screen.getByText("Binary diff")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/similarity index/)).not.toBeInTheDocument();
  });

  it("keeps a truncated preview explicit without claiming that omitted files have no changes", () => {
    render(
      <DiffViewer
        view={{
          patch: "@@ -1 +1 @@\n-old\n",
          files: [file("one.ts"), file("two.ts")],
          truncated: true,
        }}
      />,
    );
    expect(screen.getByText("Truncated")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Deleted line 1" })).toHaveTextContent("old");
    expect(screen.queryByText(/No text changes/)).not.toBeInTheDocument();
  });
});
