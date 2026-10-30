import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { useAuthStore } from "@/store/useAuthStore";

// /app 下所有页面（控制台、编辑器、预览）统一要求登录：
// 这里的 beforeLoad 会先于子路由执行，未登录一律跳登录页并带上回跳地址。
//
// 注意必须 ssr:false：令牌存 sessionStorage（仅客户端可用），beforeLoad 若在服务端
// (SSR) 阶段执行会因读不到令牌而把已登录用户误判为未登录、刷新即被踢到登录页。
// 整个 /app 是纯客户端应用（所有子路由均 ssr:false），鉴权只在客户端判定。
export const Route = createFileRoute("/app")({
  ssr: false,
  // 登录态页面统一不参与索引：声明在布局路由上，新增子路由自动继承，
  // 避免逐个文件补 noindex 时遗漏（此前就漏了 5 个）。
  head: () => ({
    meta: [{ name: "robots", content: "noindex,nofollow" }]
  }),
  beforeLoad: async ({ location }) => {
    // 游客兼容豁免（PLAN_guest_access P1）：/app/preview-template/$id 是
    // 旧模板预览路径的兼容跳板，只做 1:1 重定向到公开的 /templates/$id，
    // 不要求登录——否则旧外链会在重定向前被登录墙截住。
    if (!location.pathname.startsWith("/app/preview-template/")) {
      const { status, initialize } = useAuthStore.getState();
      // 刷新页面时本地令牌还没向后端确认过身份：先确认，避免把已登录用户误踢出去
      if (status === "unknown") {
        await initialize();
      }
      if (useAuthStore.getState().status !== "authenticated") {
        throw redirect({
          to: "/login",
          search: { redirect: location.href }
        });
      }
    }
  },
  component: () => <Outlet />
});
