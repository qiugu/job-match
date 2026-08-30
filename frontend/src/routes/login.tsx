import { createFileRoute } from "@tanstack/react-router";

import LoginPage from "@/app/app/login/page";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "登录 - JDMatch" },
      { name: "robots", content: "noindex,nofollow" }
    ]
  }),
  // 只接受站内相对路径，避免 ?redirect= 被用来跳转到外部站点（开放重定向）
  validateSearch: (search: Record<string, unknown>) => ({
    redirect:
      typeof search.redirect === "string" && search.redirect.startsWith("/")
        ? search.redirect
        : undefined
  }),
  ssr: false,
  component: LoginRouteComponent
});

function LoginRouteComponent() {
  const { redirect } = Route.useSearch();

  return <LoginPage redirectTo={redirect} />;
}
