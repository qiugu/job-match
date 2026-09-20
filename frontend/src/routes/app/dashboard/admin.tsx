import { createFileRoute } from "@tanstack/react-router";
import AdminPage from "@/app/app/dashboard/admin/page";

export const Route = createFileRoute("/app/dashboard/admin")({
  component: AdminPage,
});
