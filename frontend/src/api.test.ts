import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { api, apiPath, postApi } from "./api";

const base = "/r/0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
});

describe("Repository API", () => {
  it("scopes every endpoint and preserves its query without using the view query as a base", async () => {
    window.history.replaceState(null, "", `${base}/?view=file&path=private.txt#viewer`);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({}));
    for (const endpoint of ["repo", "status", "tree", "file", "diff", "commits", "search"]) {
      const path = `/api/${endpoint}?path=space%20%26%3F.ts&revision=HEAD`;
      await api(path);
      expect(fetchMock).toHaveBeenLastCalledWith(`${base}${path}`);
    }
  });

  it("keeps AbortSignals and JSON error messages", async () => {
    window.history.replaceState(null, "", `${base}/`);
    const signal = new AbortController().signal;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ error: "File was removed" }, { status: 404 }));
    await expect(api("/api/file?path=gone", signal)).rejects.toMatchObject({
      message: "File was removed",
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledWith(`${base}/api/file?path=gone`, { signal });
  });

  it("marks lifecycle POSTs as gitto requests", async () => {
    window.history.replaceState(null, "", `${base}/`);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({}));
    await expect(postApi("/api/heartbeat")).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledWith(`${base}/api/heartbeat`, {
      method: "POST",
      headers: { "X-Gitto-Request": "1" },
    });
  });

  it("allows legacy root APIs only for tests and the static demo", () => {
    expect(apiPath("/api/repo")).toBe("/api/repo");
    vi.stubEnv("MODE", "demo");
    window.history.replaceState(null, "", "/gitto/");
    expect(apiPath("/api/repo")).toBe("/api/repo");
    vi.stubEnv("MODE", "production");
    expect(() => apiPath("/api/repo")).toThrow(/repository URL/i);
  });

  it("does not reinterpret malformed repository URLs or external URLs as root APIs", () => {
    window.history.replaceState(null, "", "/r/not-a-registration/");
    expect(() => apiPath("/api/repo")).toThrow(/repository URL/i);
    expect(() => apiPath("https://example.com/api/repo")).toThrow(/API path/i);
  });
});
