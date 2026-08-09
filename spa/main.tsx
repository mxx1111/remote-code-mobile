import React from "react";
import { createRoot } from "react-dom/client";
import { RemoteShellDemo } from "../app/RemoteShellDemo";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RemoteShellDemo />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD && window.isSecureContext) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => undefined);
  });
}
