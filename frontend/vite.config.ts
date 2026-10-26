import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// dev 模式下浏览器的任何缓存都会制造「页面怎么改都没变」的错觉：HTML 入口
// 被启发式磁盘缓存、长命 tab 的 HMR 断链后普通刷新只会重放旧模块图。
// server.headers 覆盖不到 TanStack SSR 的 HTML 响应（静态资源能覆盖），
// 故用中间件对全部响应强制 no-store，dev 模式没有缓存需求。
function devNoStore(): Plugin {
  return {
    name: "dev-no-store",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        const writeHead = res.writeHead.bind(res);
        res.writeHead = ((...args: Parameters<typeof writeHead>) => {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          return writeHead(...args);
        }) as typeof res.writeHead;
        next();
      });
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 3005,
    // Vite dev 默认不给 HTML 入口发 Cache-Control，浏览器会做启发式缓存：
    // 用户反复看到「页面没变」实际是浏览器磁盘缓存里的旧 HTML/模块。
    // 强制 no-store，任何刷新都重新校验。
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
    },
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
    devNoStore(),
  ],
});
