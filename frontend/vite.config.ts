import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: 3005,
    // 开发模式无 Nginx，把 /api 反代到后端（8005），前端用同源相对路径 /api/...
    // 即可打到后端，行为与生产 Nginx 同源代理一致。
    proxy: {
      "/api": {
        target: "http://localhost:8005",
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist"],
  },
  ssr: {
    noExternal: ["pdfjs-dist"],
  },
  plugins: [
    tsconfigPaths(),
    tanstackStart({
      srcDirectory: "src",
      router: {
        routesDirectory: "routes",
      },
    }),
    viteReact(),
  ],
});
