import React from "react";
import { createRoot } from "react-dom/client";
import { RemoteShellDemo } from "../app/RemoteShellDemo";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RemoteShellDemo />
  </React.StrictMode>,
);
