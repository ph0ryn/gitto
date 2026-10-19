import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./app";
import RepositorySession from "./repositorySession";
import "./styles.css";

if (import.meta.env.MODE === "demo") {
  const { demoFetch } = await import("./demo");
  globalThis.fetch = demoFetch;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RepositorySession>
      <App />
    </RepositorySession>
  </StrictMode>,
);
