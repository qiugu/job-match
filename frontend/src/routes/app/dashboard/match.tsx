import { createFileRoute } from "@tanstack/react-router";
import JobMatchPage from "@/app/app/dashboard/match/page";

export const Route = createFileRoute("/app/dashboard/match")({
  component: JobMatchPage,
});
