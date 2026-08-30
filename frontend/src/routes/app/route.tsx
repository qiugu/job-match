import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { useAuthStore } from "@/store/useAuthStore";

// /app 下所有页面（控制台、编辑器、预览）统一要求登录：
// 这里的 beforeLoad 会先于子路由执行，未登录一律跳登录页并带上回跳地址。
export const Route = createFileRoute("/app")({
  beforeLoad: async ({ location }) => {
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
  },
  component: () => <Outlet />
});
