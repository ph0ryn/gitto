export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function repositoryBasePath(): string | null {
  if (import.meta.env.MODE === "demo") return null;
  const match = /^\/r\/([0-9a-f]{32})\/?$/.exec(window.location.pathname);
  if (match) return `/r/${match[1]}`;
  if (window.location.pathname.startsWith("/r/")) {
    throw new Error("Invalid repository URL. Open the repository URL printed by gitto.");
  }
  return null;
}

export function apiPath(path: string): string {
  if (!path.startsWith("/api/")) throw new Error("Expected a repository API path.");
  const base = repositoryBasePath();
  if (base) return `${base}${path}`;
  if (import.meta.env.MODE === "demo" || import.meta.env.MODE === "test") return path;
  throw new Error("Open the repository URL printed by gitto.");
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = apiPath(path);
  const response = await (options ? fetch(url, options) : fetch(url));
  const data = (await response.json()) as T & { error?: string };
  options?.signal?.throwIfAborted();
  if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status);
  return data;
}

export function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request(path, signal ? { signal } : undefined);
}

export function postApi(path: string, signal?: AbortSignal): Promise<Record<string, never>> {
  return request(path, {
    method: "POST",
    headers: { "X-Gitto-Request": "1" },
    ...(signal ? { signal } : {}),
  });
}
