import "@testing-library/jest-dom/vitest";
import { flavors } from "@catppuccin/palette";
import { icons } from "@iconify-json/catppuccin";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import EntryIcon from "./entryIcon";

afterEach(cleanup);

describe("EntryIcon", () => {
  it.each([
    { name: "unknown.xyz", kind: "blob", expected: "file" },
    { name: "unknown", kind: "tree", expected: "folder" },
    { name: "linked.ts", kind: "symlink", expected: "symlink" },
    { name: "external", kind: "submodule", expected: "folder-git" },
  ] as const)("renders $expected artwork for $kind entries", ({ name, kind, expected }) => {
    const { container } = render(<EntryIcon name={name} kind={kind} />);
    expect(container.querySelector("svg path")).toHaveAttribute(
      "d",
      icons.icons[expected].body.match(/ d="([^"]+)"/)?.[1],
    );
  });

  it("uses Latte colors on the light interface", () => {
    const { container } = render(<EntryIcon name="main.ts" kind="blob" />);
    expect(container.querySelector("svg [stroke]")).toHaveAttribute(
      "stroke",
      flavors.latte.colors.blue.hex,
    );
  });
});
