
import { useNavigate } from "@tanstack/react-router";

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
        navigate({ to: routeMap[type] });
      }}
    >
      {children}
    </form>
  );
}
