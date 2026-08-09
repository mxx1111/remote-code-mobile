import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.REMOTE_SHELL_DEV_HOST ?? "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3001",
    },
  },
});
