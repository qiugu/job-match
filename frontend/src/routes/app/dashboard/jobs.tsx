import { createFileRoute } from "@tanstack/react-router";
import JobsPage from "@/app/app/dashboard/jobs/page";

export const Route = createFileRoute("/app/dashboard/jobs")({
  component: JobsPage,
});
