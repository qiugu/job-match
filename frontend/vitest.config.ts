import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [tsconfigPaths({ loose: true })],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
