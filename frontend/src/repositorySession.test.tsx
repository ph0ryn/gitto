import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import App from "./app";
import { demoFetch } from "./demo";
import RepositorySession from "./repositorySession";

const base = "/r/0123456789abcdef0123456789abcdef";
const closeKey = "gitto:closed:0123456789abcdef0123456789abcdef";

function installFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (typeof input !== "string" || !input.startsWith(`${base}/api/`))
      throw new Error("Unexpected unscoped request.");
    const path = input.slice(base.length);
    if (path === "/api/heartbeat" || path === "/api/close")
      return Promise.resolve(Response.json({}));
    return demoFetch(path, init);
  });
}

async function mount() {
  window.history.replaceState(null, "", `${base}/`);
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <RepositorySession>
        <App />
      </RepositorySession>,
    );
  });
  return result;
}

async function click(name: string) {
  await act(async () => fireEvent.click(screen.getByRole("button", { name })));
}

async function advance(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  document.title = "gitto";
  window.history.replaceState(null, "", "/");
  localStorage.removeItem(closeKey);
});

describe("Repository session", () => {
  it("heartbeats immediately and every 2s, even in a hidden tab, with scoped POST headers", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const fetchMock = installFetch();
    await mount();
    const heartbeats = () =>
      fetchMock.mock.calls.filter(([url]) => url === `${base}/api/heartbeat`);
    expect(heartbeats()).toHaveLength(1);
    expect(heartbeats()[0][1]).toMatchObject({
      method: "POST",
      headers: { "X-Gitto-Request": "1" },
    });
    await advance(1999);
    expect(heartbeats()).toHaveLength(1);
    await advance(1);
    expect(heartbeats()).toHaveLength(2);
    await advance(4000);
    expect(heartbeats()).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "hello-gitto" })).toBeVisible();
    expect(
      fetchMock.mock.calls.every(
        ([url]) => typeof url === "string" && url.startsWith(`${base}/api/`),
      ),
    ).toBe(true);
  });

  it("places an accessible close icon immediately after the branch selector", async () => {
    vi.useFakeTimers();
    installFetch();
    await mount();
    const branch = screen.getByRole("combobox", { name: "Branch" });
    const close = screen.getByRole("button", { name: "Close repository" });
    expect(branch.nextElementSibling).toBe(close);
    expect(close).not.toHaveTextContent(/\S/);
    expect(close).toHaveAttribute("title", "Close repository");
    expect(close.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it.each(["repo", "tree"])("can close after /api/%s fails to load", async (endpoint) => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) =>
      typeof input === "string" && input.split("?")[0] === `${base}/api/${endpoint}`
        ? Promise.resolve(Response.json({ error: "Repository unavailable" }, { status: 500 }))
        : originalFetch(input, init),
    );
    await mount();
    expect(screen.getByText("Could not load repository")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    await click("Close repository");
    expect(fetchMock).toHaveBeenCalledWith(`${base}/api/close`, {
      method: "POST",
      headers: { "X-Gitto-Request": "1" },
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    expect(localStorage.getItem(closeKey)).toBe("1");
    const count = fetchMock.mock.calls.length;
    await advance(10000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("never closes on pagehide, beforeunload, unload, or component unmount", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    const result = await mount();
    for (const event of ["beforeunload", "pagehide", "unload"]) fireEvent(window, new Event(event));
    result.unmount();
    const count = fetchMock.mock.calls.length;
    await advance(6000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(
      fetchMock.mock.calls.some(([url]) => typeof url === "string" && url.endsWith("/close")),
    ).toBe(false);
  });

  it("closes immediately without confirmation and clears all repository content on success", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    await mount();
    await click("README.md");
    expect(screen.getByRole("region", { name: "Repository content" })).toHaveTextContent(
      "hello-gitto",
    );
    await click("Close repository");
    expect(
      screen.queryByRole("group", { name: "Close repository in all tabs?" }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`${base}/api/close`, {
      method: "POST",
      headers: { "X-Gitto-Request": "1" },
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("hello-gitto");
    expect(document.body).not.toHaveTextContent("/demo/");
    expect(screen.queryByRole("region", { name: "Repository content" })).not.toBeInTheDocument();
    expect(document.title).toBe("Repository closed | gitto");
    expect(localStorage.getItem(closeKey)).toBe("1");
    const count = fetchMock.mock.calls.length;
    await advance(10000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("disables the close icon while the immediate close request is pending", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    const originalFetch = fetchMock.getMockImplementation()!;
    let resolveClose!: (value: Response) => void;
    const pendingClose = new Promise<Response>((resolve) => {
      resolveClose = resolve;
    });
    fetchMock.mockImplementation((input, init) =>
      input === `${base}/api/close` ? pendingClose : originalFetch(input, init),
    );
    await mount();
    await click("Close repository");
    expect(screen.getByRole("button", { name: "Close repository" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close all tabs" })).not.toBeInTheDocument();
    await click("Close repository");
    expect(fetchMock.mock.calls.filter(([url]) => url === `${base}/api/close`)).toHaveLength(1);
    await act(async () => resolveClose(Response.json({})));
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
  });

  it("keeps the repository open after a failed close and lets the user retry", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    const originalFetch = fetchMock.getMockImplementation()!;
    let closeFails = true;
    fetchMock.mockImplementation((input, init) =>
      input === `${base}/api/close` && closeFails
        ? Promise.resolve(Response.json({ error: "Temporarily unavailable" }, { status: 503 }))
        : originalFetch(input, init),
    );
    await mount();
    await click("Close repository");
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not close repository/);
    expect(screen.getByRole("alert")).toHaveTextContent("Temporarily unavailable");
    expect(localStorage.getItem(closeKey)).toBeNull();
    expect(screen.getByRole("heading", { name: "hello-gitto" })).toBeVisible();
    await advance(2000);
    expect(screen.queryByRole("heading", { name: "Repository closed" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close repository" })).toBeEnabled();
    closeFails = false;
    await click("Close repository");
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
  });

  it("treats another tab's removal as terminal on heartbeat 404 and stops every poll", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    await mount();
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) =>
      input === `${base}/api/heartbeat`
        ? Promise.resolve(
            Response.json({ error: "Repository registration was removed" }, { status: 404 }),
          )
        : originalFetch(input, init),
    );
    await advance(2000);
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("hello-gitto");
    const count = fetchMock.mock.calls.length;
    await advance(10000);
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("closes on a same-repository storage notification even after the server exits", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    await mount();
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    await advance(2000);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
    await act(async () => {
      localStorage.setItem(closeKey, "1");
      fireEvent(
        window,
        new StorageEvent("storage", {
          key: closeKey,
          newValue: "1",
          storageArea: localStorage,
        }),
      );
    });
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    const count = fetchMock.mock.calls.length;
    await advance(10000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("retains successful close across remount without retrying an exited server", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    const result = await mount();
    await click("Close repository");
    result.unmount();
    fetchMock.mockClear().mockRejectedValue(new TypeError("Failed to fetch"));
    await mount();
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    await advance(6000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks a missed close marker before a resumed heartbeat", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    await mount();
    localStorage.setItem(closeKey, "1");
    const heartbeatCount = () =>
      fetchMock.mock.calls.filter(([url]) => url === `${base}/api/heartbeat`).length;
    const beforeResume = heartbeatCount();
    await advance(2000);
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    expect(heartbeatCount()).toBe(beforeResume);
    const count = fetchMock.mock.calls.length;
    await advance(6000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("does not fail a successful close when browser storage is denied", async () => {
    vi.useFakeTimers();
    installFetch();
    await mount();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    await click("Close repository");
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/could not notify other tabs/i);
    expect(document.body).not.toHaveTextContent("hello-gitto");
  });

  it("bounds a hung heartbeat and retries without overlapping requests", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    const originalFetch = fetchMock.getMockImplementation()!;
    let hungSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          hungSignal = init?.signal;
          hungSignal?.addEventListener("abort", () => reject(hungSignal?.reason));
        }),
    );
    await mount();
    await advance(4000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hungSignal?.aborted).toBe(false);
    await advance(1000);
    expect(hungSignal?.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
    fetchMock.mockImplementation(originalFetch);
    await advance(1000);
    expect(screen.getByRole("heading", { name: "hello-gitto" })).toBeVisible();
  });

  it("never loads repository data when its first heartbeat reports a removed registration", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch().mockResolvedValue(
      Response.json({ error: "Registration removed" }, { status: 404 }),
    );
    await mount();
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(6000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not confuse a missing file with a removed repository registration", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    await mount();
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) =>
      typeof input === "string" && input.startsWith(`${base}/api/file`)
        ? Promise.resolve(Response.json({ error: "File was removed" }, { status: 404 }))
        : originalFetch(input, init),
    );
    await click("README.md");
    expect(screen.getByRole("alert")).toHaveTextContent("File was removed");
    await advance(2000);
    expect(screen.getByRole("heading", { name: "hello-gitto" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Repository closed" })).not.toBeInTheDocument();
  });

  it("does not start more repository loads if another tab closes it during startup", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    const originalFetch = fetchMock.getMockImplementation()!;
    let resolveRepo!: (value: Response) => void;
    const pendingRepo = new Promise<Response>((resolve) => {
      resolveRepo = resolve;
    });
    let removed = false;
    fetchMock.mockImplementation((input, init) => {
      if (input === `${base}/api/repo`) return pendingRepo;
      if (input === `${base}/api/heartbeat` && removed)
        return Promise.resolve(Response.json({ error: "Registration removed" }, { status: 404 }));
      return originalFetch(input, init);
    });
    await mount();
    removed = true;
    await advance(2000);
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    const count = fetchMock.mock.calls.length;
    await act(async () => resolveRepo(await demoFetch("/api/repo")));
    expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(document.body).not.toHaveTextContent("hello-gitto");
  });

  it("does not reopen on a late successful heartbeat after an explicit close", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    await mount();
    const originalFetch = fetchMock.getMockImplementation()!;
    let resolveHeartbeat!: (value: Response) => void;
    const pendingHeartbeat = new Promise<Response>((resolve) => {
      resolveHeartbeat = resolve;
    });
    fetchMock.mockImplementation((input, init) =>
      input === `${base}/api/heartbeat` ? pendingHeartbeat : originalFetch(input, init),
    );
    await advance(2000);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close repository" }));
      resolveHeartbeat(Response.json({}));
    });
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
    await advance(4000);
    expect(screen.getByRole("heading", { name: "Repository closed" })).toBeVisible();
  });

  it.each(["network", "transient"])(
    "retries an initial %s failure and reconnects without reload",
    async (failure) => {
      vi.useFakeTimers();
      const fetchMock = installFetch();
      const originalFetch = fetchMock.getMockImplementation()!;
      let disconnected = true;
      fetchMock.mockImplementation((input, init) => {
        if (input === `${base}/api/heartbeat` && disconnected)
          return failure === "network"
            ? Promise.reject(new TypeError("Failed to fetch"))
            : Promise.resolve(Response.json({ error: "Restarting" }, { status: 503 }));
        return originalFetch(input, init);
      });
      await mount();
      expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
      expect(screen.getByRole("status")).toHaveTextContent(/gitto/);
      expect(screen.queryByRole("heading", { name: "Repository closed" })).not.toBeInTheDocument();
      await advance(4000);
      expect(fetchMock.mock.calls.filter(([url]) => url === `${base}/api/heartbeat`)).toHaveLength(
        3,
      );
      disconnected = false;
      await advance(2000);
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "hello-gitto" })).toBeVisible();
    },
  );

  it("restores the selected view after a running server disconnects and restarts", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch();
    await mount();
    await click("README.md");
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    await advance(2000);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
    fetchMock.mockImplementation(originalFetch);
    await advance(2000);
    expect(screen.getByRole("heading", { name: "README.md" })).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Repository content" })).getByText("# hello-gitto"),
    ).toBeVisible();
  });

  it.each(["test", "demo"])("does not create a live lifecycle for a %s root page", async (mode) => {
    vi.useFakeTimers();
    vi.stubEnv("MODE", mode);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(demoFetch);
    await act(async () => {
      render(
        <RepositorySession>
          <App />
        </RepositorySession>,
      );
    });
    await advance(4000);
    expect(screen.getByRole("heading", { name: "hello-gitto" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Close repository" })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && /\/(heartbeat|close)$/.test(url),
      ),
    ).toBe(false);
  });
});
