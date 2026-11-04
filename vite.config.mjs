import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend",
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(
      ["/token", "/call-logs", "/message-logs", "/contacts", "/messages"].map(
        (route) => [route, "http://localhost:3001"],
      ),
    ),
  },
});
