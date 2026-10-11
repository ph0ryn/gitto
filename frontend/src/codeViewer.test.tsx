import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import CodeViewer from "./codeViewer";

afterEach(cleanup);

describe("CodeViewer", () => {
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
