
import { useNavigate } from "@tanstack/react-router";
import { trackGrowthEvent } from "@/lib/telemetry";

export default function GoDashboard({
  children,
  type = "match",
}: {
  children: React.ReactNode;
  type?: "dashboard" | "templates" | "match";
}) {
  const navigate = useNavigate();

  const routeMap = {
    dashboard: "/app/dashboard",
    match: "/app/dashboard/match",
    templates: "/app/dashboard/templates"
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void trackGrowthEvent("cta_click");
        navigate({ to: routeMap[type] });
      }}
    >
      {children}
    </form>
  );
}
