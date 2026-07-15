import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Electron main/preload are compiled with tsc (see tsconfig.electron.json).
// Dev: run `npm run electron:dev` after `npm run build:electron` once, or use the full start path.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
});
