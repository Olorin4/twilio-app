import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend",
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(
      [
        "/token",
        "/call-logs",
        "/activity-counts",
        "/activity-views",
        "/reconcile",
        "/settings",
        "/message-logs",
        "/message-events",
        "/conversations",
        "/conversation",
        "/contacts",
        "/messages",
      ].map((route) => [route, "http://localhost:3001"]),
    ),
  },
});
