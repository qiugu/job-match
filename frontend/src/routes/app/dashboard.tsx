import { createFileRoute, Outlet } from "@tanstack/react-router";
import DashboardLayout from "@/app/app/dashboard/client";

// noindex 统一由父布局路由 /app（routes/app/route.tsx）声明，此处不再重复。
export const Route = createFileRoute("/app/dashboard")({
  ssr: false,
  component: DashboardRouteLayout
});

function DashboardRouteLayout() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  );
}
