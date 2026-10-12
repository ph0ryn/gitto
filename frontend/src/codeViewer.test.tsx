import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import CodeViewer from "./codeViewer";

afterEach(cleanup);

describe("CodeViewer", () => {
  it("bounds search highlights while preserving all source text", () => {
    const content = "x".repeat(1100);
    const { container, rerender } = render(
      <CodeViewer content={content} path="plain.txt" searchQuery="x" />,
    );
    expect(container.querySelectorAll("mark")).toHaveLength(1000);
    expect(container.querySelector("code")?.textContent).toBe(content);
    rerender(<CodeViewer content={"x".repeat(16 * 1024 + 1)} path="plain.txt" searchQuery="x" />);
    expect(container.querySelector("mark")).not.toBeInTheDocument();
    expect(container.querySelector("code")?.textContent).toHaveLength(16 * 1024 + 1);
  });

  it("highlights literal matches across syntax tokens without executing source HTML", () => {
    const content = "const value = '<script>unsafe()</script>';\r\nconst other = 2;\r\n";
    const { container, rerender } = render(
      <CodeViewer content={content} path="main.ts" startLine={12} searchQuery="const value" />,
    );
    expect(container.querySelector("code")?.textContent).toBe(content);
    expect(
      Array.from(container.querySelectorAll("mark"))
        .map((mark) => mark.textContent)
        .join(""),
    ).toBe("const value");
    expect(container.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(container.querySelector("code script")).not.toBeInTheDocument();
    expect(container.querySelector(".line-numbers")?.textContent).toBe("12\n13");
    rerender(<CodeViewer content={content} path="main.ts" searchQuery="<script>" />);
    expect(container.querySelector("mark")).toHaveTextContent("<script>");
    expect(container.querySelector("code script")).not.toBeInTheDocument();
  });

  it("disables syntax highlighting above 16 KiB of UTF-8 without changing source text", () => {
    const content = `const name = "${"語".repeat(6000)}";\r\n<script>unsafe()</script>\r\n`;
    const { container } = render(<CodeViewer content={content} path="main.ts" />);

    expect(container.querySelector("code")?.textContent).toBe(content);
    expect(container.querySelector("code span")).not.toBeInTheDocument();
    expect(container.querySelector("code script")).not.toBeInTheDocument();
    expect(container.querySelector(".line-numbers")?.textContent).toBe("1\n2");
  });

  it("keeps syntax highlighting at the 16 KiB boundary", () => {
    const content = "const value = 1;".padEnd(16 * 1024, " ");
    const { container } = render(<CodeViewer content={content} path="main.ts" />);

    expect(container.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(container.querySelector("code")?.textContent).toBe(content);
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
