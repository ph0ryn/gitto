import { describe, expect, it } from "vite-plus/test";

import config from "./vite.config";

describe("Repository development proxy", () => {
  it("only proxies repository-scoped APIs to the fixed backend", () => {
    const proxies = config.server?.proxy;
    expect(Object.keys(proxies ?? {})).toEqual(["^/r/[^/]+/api"]);
    const key = "^/r/[^/]+/api";
    expect(new RegExp(key).test("/r/0123456789abcdef0123456789abcdef/api/heartbeat")).toBe(true);
    for (const path of ["/api/repo", "/assets/main.js", "/r/registration/", "/gitto/"])
      expect(new RegExp(key).test(path)).toBe(false);
    const proxy = proxies?.[key];
    expect(proxy).toMatchObject({ target: "http://127.0.0.1:47319", changeOrigin: true });
  });

  it.each([
    { origin: "http://127.0.0.1:5173", expected: "http://127.0.0.1:47319" },
    { origin: "https://attacker.example", expected: "https://attacker.example" },
    {
      origin: "http://127.0.0.1:5173.attacker.example",
      expected: "http://127.0.0.1:5173.attacker.example",
    },
    { origin: "null", expected: "null" },
    { origin: undefined, expected: undefined },
  ])("only rewrites the exact Vite Origin ($origin)", async ({ origin, expected }) => {
    const proxy = config.server?.proxy?.["^/r/[^/]+/api"];
    if (!proxy || typeof proxy === "string" || !proxy.bypass)
      throw new Error("Expected the scoped development proxy.");
    const request = { headers: { origin } };
    await proxy.bypass(request, undefined, proxy);
    expect(request.headers.origin).toBe(expected);
  });
});
