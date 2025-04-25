import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      '/token': 'http://localhost:3001',
      '/messages': 'http://localhost:3001',
      '/call-logs': 'http://localhost:3001',
      '/voice': 'http://localhost:3001',
      '/sms': 'http://localhost:3001',
    }
  }
});
