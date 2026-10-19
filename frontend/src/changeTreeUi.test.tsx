import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import ChangeTree, {
  buildChangeDecorations,
  buildChangeTree,
  type ChangeEntry,
} from "./changeTree";
import "./styles.css";

afterEach(cleanup);

describe("ChangeTree file names", () => {
  it.each(["staged", "unstaged", "commit"] as const)(
    "uses a double strikethrough only for deleted file names in %s changes",
    (source) => {
      const entries: ChangeEntry[] = [
        "deleted",
        "modified",
        "added",
        "untracked",
        "renamed",
        "conflicted",
      ].map((status) => ({
        path: `src/${status}.ts`,
        oldPath: null,
        status,
        source,
        stats: { additions: 0, deletions: 2, binary: false },
      }));
      render(
        <ChangeTree
          nodes={buildChangeTree(entries)}
          decorations={buildChangeDecorations(entries)}
          disabled={false}
          selected={null}
          onSelect={vi.fn()}
        />,
      );

      expect(screen.getByText("deleted.ts")).toHaveStyle(
        "text-decoration-line: line-through; text-decoration-style: double",
      );
      for (const entry of entries.filter((entry) => entry.status !== "deleted")) {
        expect(screen.getByText(`${entry.status}.ts`)).not.toHaveStyle(
          "text-decoration-line: line-through",
        );
      }
      for (const element of [screen.getByText("src"), ...screen.getAllByText("− 2")]) {
        expect(element).not.toHaveStyle("text-decoration-line: line-through");
      }
    },
  );
});
