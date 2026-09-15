import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  resolve: {
    alias: {
      // 本目录在 frontend/scripts/editor-probe/，源码根在 frontend/src → 上溯两级
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  logLevel: "warn",
});
