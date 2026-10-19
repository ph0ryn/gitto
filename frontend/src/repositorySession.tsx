import { createContext, useContext, useEffect, useRef, useState } from "react";

import { ApiError, postApi, repositoryBasePath } from "./api";

import type { ReactNode } from "react";

type SessionState = "connecting" | "connected" | "reconnecting" | "closed";

const RepositoryCloseContext = createContext<ReactNode>(null);

export function RepositoryCloseButton() {
  return useContext(RepositoryCloseContext);
}

function wasClosed(key: string | null): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    // Browser storage can be denied; the server remains authoritative in that case.
    return false;
  }
}

export default function RepositorySession({ children }: { children: ReactNode }) {
  const base = repositoryBasePath();
  // Explicitly removed IDs are never reused. Store no repository names, paths, or content.
  const closeKey = base ? `gitto:closed:${base.slice(3)}` : null;
  const [state, setState] = useState<SessionState>(() =>
    wasClosed(closeKey) ? "closed" : "connecting",
  );
  const [notificationFailed, setNotificationFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closeRequest = useRef<AbortController | null>(null);
  const closed = state === "closed";

  useEffect(() => {
    if (!base || closed) return;
    let disposed = false;
    let pending: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout>;
    async function heartbeat() {
      if (wasClosed(closeKey)) {
        setState("closed");
        return;
      }
      if (pending) return;
      const controller = new AbortController();
      pending = controller;
      timeout = setTimeout(() => controller.abort(), 5000);
      try {
        await postApi("/api/heartbeat", controller.signal);
        if (!disposed) setState((current) => (current === "closed" ? current : "connected"));
      } catch (reason) {
        if (!disposed) {
          setState((current) =>
            current === "closed" || (reason instanceof ApiError && reason.status === 404)
              ? "closed"
              : "reconnecting",
          );
        }
      } finally {
        clearTimeout(timeout);
        pending = null;
      }
    }
    void heartbeat();
    const timer = setInterval(() => void heartbeat(), 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(timeout);
      pending?.abort();
    };
  }, [base, closeKey, closed]);

  useEffect(() => {
    if (!closeKey || closed) return;
    function receiveClose(event: StorageEvent) {
      if (event.key === closeKey && event.newValue === "1") setState("closed");
    }
    window.addEventListener("storage", receiveClose);
    return () => window.removeEventListener("storage", receiveClose);
  }, [closeKey, closed]);

  useEffect(() => {
    if (closed) {
      document.title = "Repository closed | gitto";
      closeRequest.current?.abort();
    }
  }, [closed]);

  useEffect(() => () => closeRequest.current?.abort(), []);

  async function closeRepository() {
    const controller = new AbortController();
    closeRequest.current = controller;
    setClosing(true);
    setCloseError(null);
    try {
      await postApi("/api/close", controller.signal);
      if (!controller.signal.aborted) {
        setState("closed");
        try {
          if (closeKey) localStorage.setItem(closeKey, "1");
        } catch {
          // Registration removal succeeded even if this browser cannot notify its other tabs.
          setNotificationFailed(true);
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof ApiError && reason.status === 404) setState("closed");
        else {
          const detail = reason instanceof Error ? reason.message : "Request failed.";
          setCloseError(`Could not close repository. Try again. ${detail}`);
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        closeRequest.current = null;
        setClosing(false);
      }
    }
  }

  if (!base) return children;

  if (closed) {
    return (
      <main className="app-state" role="status">
        <h1>Repository closed</h1>
        <p>
          Its registration has been removed from gitto. This repository is closed in every tab. Your
          Git repository and working tree have not changed.
        </p>
        {notificationFailed && (
          <p role="alert">Your browser could not notify other tabs. Close those tabs manually.</p>
        )}
        <p>To open it again, run gitto for this repository.</p>
      </main>
    );
  }

  if (state !== "connected") {
    return (
      <main className="app-state" role="status">
        <strong>{state === "connecting" ? "Connecting…" : "Reconnecting…"}</strong>
        <p>
          {state === "connecting"
            ? "Connecting to the repository server."
            : "Keep this tab open to retry. If the server has stopped, run gitto for this repository to restart it."}
        </p>
      </main>
    );
  }

  return (
    <div className="repository-session">
      {closeError && (
        <p className="session-error" role="alert">
          {closeError}
        </p>
      )}
      <RepositoryCloseContext.Provider
        value={
          <button
            className="icon-button repository-close-button"
            aria-label="Close repository"
            title="Close repository"
            onClick={() => void closeRepository()}
            disabled={closing}
          >
            <svg
              className="ui-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m7 7 10 10M7 17 17 7" />
            </svg>
          </button>
        }
      >
        {children}
      </RepositoryCloseContext.Provider>
    </div>
  );
}
