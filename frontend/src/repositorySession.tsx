import { useEffect, useRef, useState } from "react";

import { ApiError, postApi, repositoryBasePath } from "./api";

import type { ReactNode } from "react";

type SessionState = "connecting" | "connected" | "reconnecting" | "closed";

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
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    if (confirmClose) cancelButton.current?.focus();
  }, [confirmClose, state]);

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
      <div className="session-toolbar">
        <button
          ref={closeButton}
          aria-expanded={confirmClose}
          aria-controls={confirmClose ? "close-repository-confirmation" : undefined}
          onClick={() => setConfirmClose(true)}
          disabled={closing}
        >
          Close repository
        </button>
      </div>
      {confirmClose && (
        <div
          id="close-repository-confirmation"
          className="session-confirmation"
          role="group"
          aria-labelledby="close-repository-title"
        >
          <div>
            <strong id="close-repository-title">Close repository in all tabs?</strong>
            <p>
              This removes its registration from gitto and closes this repository in every tab. Your
              Git repository and working tree will not change.
            </p>
            {closeError && <p role="alert">{closeError}</p>}
          </div>
          <div className="session-actions">
            <button
              ref={cancelButton}
              disabled={closing}
              onClick={() => {
                setConfirmClose(false);
                setCloseError(null);
                // The trigger stays mounted, so keyboard focus returns to the originating action.
                closeButton.current?.focus();
              }}
            >
              Cancel
            </button>
            <button disabled={closing} onClick={() => void closeRepository()}>
              {closing ? "Closing…" : "Close all tabs"}
            </button>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
