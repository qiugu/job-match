import { createFileRoute } from "@tanstack/react-router";
import AnalyticsPage from "@/app/app/dashboard/analytics/page";

export const Route = createFileRoute("/app/dashboard/analytics")({
  component: AnalyticsPage,
});
