import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 3005,
    // 仓库位于外置卷（/Volumes/...）：fsevents 在磁盘休眠/重挂载后会静默失效，
    // 曾导致 dev server 持续下发陈旧模块与 CSS（表现为「页面怎么改都没变」）。
    // 轮询兜底，保证 HMR 可靠。
    watch: { usePolling: true, interval: 1000 },
    // 开发模式无 Nginx，把 /api 反代到后端（8005），前端用同源相对路径 /api/...
    // 即可打到后端，行为与生产 Nginx 同源代理一致。
    proxy: {
      "/api": {
        target: "http://localhost:8005",
        changeOrigin: true,
      },
    },
  },
  plugins: [
    tsconfigPaths({ loose: true }),
    tanstackStart({
      srcDirectory: "src",
      router: {
        routesDirectory: "routes",
      },
    }),
    viteReact(),
  ],
});
