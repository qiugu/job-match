/**
 * 落地页「免登录试用」按钮的跳转容器（PLAN_guest_access）：
 * 与 GoDashboard 同构，但目标是游客编辑器 /edit——未登录直接进入，
 * 已登录会被 /edit 路由守卫重定向到控制台，无需在这里判断登录态。
 */

import { useNavigate } from "@tanstack/react-router";
import { trackGrowthEvent } from "@/lib/telemetry";

export default function GoTryEditor({
  children,
}: {
  children: React.ReactNode;
}) {
  const navigate = useNavigate();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void trackGrowthEvent("cta_click", { path: "/edit" });
        // /edit 声明了 validateSearch（template 可选），类型上要求显式给出
        // 完整 search 形状才能通过 navigate 的约束
        navigate({ to: "/edit", search: { template: undefined } });
      }}
    >
      {children}
    </form>
  );
}
