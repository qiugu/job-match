import { useState } from "react";
import { BarChart3, Briefcase, KeyRound } from "lucide-react";
import { toast } from "sonner";
import {
  IconChevronDown,
  IconDoc,
  IconGrid,
  IconLogout,
  IconTarget,
} from "@/components/shared/icons/XaiIcons";
import { usePathname, useRouter } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChangePasswordDialog } from "@/components/shared/ChangePasswordDialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import Logo from "@/components/shared/Logo";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import { useAuthStore } from "@/store/useAuthStore";

interface MenuItem {
  title: string;
  url?: string;
  href?: string;
  icon: any;
  items?: { title: string; href: string }[];
}

const DashboardLayout = ({ children }: { children: React.ReactNode }) => {
  const t = useTranslations("dashboard");
  const tAuth = useTranslations();
  const user = useAuthStore((state) => state.user);
  const displayName = user?.nickname || user?.username || "";
  // 负值（管理员默认 -1）即无限制；无限额度用独立整句，不套「剩余积分」前缀
  const quotaText =
    user && user.credits < 0
      ? tAuth("auth.quotaUnlimited")
      : `${tAuth("auth.quota")} · ${user?.credits ?? 0}`;
  const sidebarItems: MenuItem[] = [
    {
      title: t("sidebar.jobmatch"),
      url: "/app/dashboard/match",
      icon: IconTarget,
    },
    {
      // 岗位卡（机会管理）：独立入口，取代匹配页内的抽屉按钮
      title: t("sidebar.jobs"),
      url: "/app/dashboard/jobs",
      icon: Briefcase,
    },
    {
      // 投递分析：按日趋势 / 漏斗 / 状态分布，与「我的投递」并列的报表入口
      title: t("sidebar.analytics"),
      url: "/app/dashboard/analytics",
      icon: BarChart3,
    },
    {
      title: t("sidebar.resumes"),
      url: "/app/dashboard/resumes",
      icon: IconDoc,
    },
    {
      title: t("sidebar.templates"),
      url: "/app/dashboard/templates",
      icon: IconGrid,
    },
  ];

  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale();
  const [open, setOpen] = useState(true);
  const [collapsible, setCollapsible] = useState<"offcanvas" | "icon" | "none">(
    "icon"
  );
  const [passwordOpen, setPasswordOpen] = useState(false);

  const handleItemClick = (item: MenuItem) => {
    if (item.items) {

    } else {
      router.push(item.url || item.href || "/");
    }
  };

  const isItemActive = (item: MenuItem) => {
    if (item.items) {
      return item.items.some((subItem) => pathname === subItem.href);
    }
    return item.url === pathname || item.href === pathname;
  };

  const handleLogout = async () => {
    await useAuthStore.getState().logout();
    toast.success(tAuth("auth.logoutSuccess"));
    router.push("/login");
  };

  return (
    <div
      className="theme-xai flex h-screen w-full overflow-hidden"
      style={{ "--sidebar-width": "228px" } as React.CSSProperties}
    >
      <SidebarProvider open={open} onOpenChange={setOpen}>
        <Sidebar
          collapsible={collapsible}
          className="border-r border-xai-hairline-soft bg-xai-canvas"
        >
          <SidebarHeader className="h-[66px] flex-row items-center gap-2.5 border-b border-xai-hairline-soft px-5 py-0">
            <div
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5"
              onClick={() => router.push(`/${locale}`)}
            >
              <Logo
                className="shrink-0 transition-opacity hover:opacity-80"
                size={26}
              />
              {open && (
                <span className="truncate text-[15px] font-medium tracking-tight text-xai-text">
                  {t("sidebar.appName")}
                </span>
              )}
            </div>
            {open && (
              <SidebarTrigger className="size-7 shrink-0 text-xai-eyebrow transition-colors hover:text-xai-text" />
            )}
          </SidebarHeader>

          <SidebarContent className="px-4 py-6">
            <SidebarGroup className="p-0">
              <SidebarGroupContent>
                {/* 等宽大写分组标签，纯装饰、不随语言切换 */}
                {open && (
                  <p className="xai-eyebrow mb-3 pl-3 text-[10px]">
                    WORKSPACE
                  </p>
                )}
                <SidebarMenu className="space-y-1.5">
                  {sidebarItems.map((item) => {
                    const active = isItemActive(item);
                    return (
                      <TooltipProvider delayDuration={0} key={item.title}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <SidebarMenuItem key={item.title}>
                              <SidebarMenuButton
                                asChild
                                isActive={active}
                                className={cn(
                                  "h-10 w-full rounded-full px-3.5 transition-colors duration-150",
                                  active
                                    ? "bg-xai-text text-xai-canvas hover:bg-xai-text hover:text-xai-canvas"
                                    : "text-xai-mute hover:bg-xai-surface-2 hover:text-xai-text"
                                )}
                              >
                                <div
                                  className="flex min-w-0 items-center gap-2.5 cursor-pointer"
                                  onClick={() => handleItemClick(item)}
                                >
                                  <item.icon
                                    size={18}
                                    className="shrink-0"
                                  />
                                  {open && (
                                    <span
                                      className={cn(
                                        "flex-1 truncate text-[13px]",
                                        active && "font-medium"
                                      )}
                                    >
                                      {item.title}
                                    </span>
                                  )}
                                </div>
                              </SidebarMenuButton>
                              {item.items && open && (
                                <div className="ml-9 mt-1 space-y-1 border-l border-xai-hairline pl-3">
                                  {item.items.map((subItem) => (
                                    <div
                                      key={subItem.href}
                                      className={cn(
                                        "cursor-pointer rounded-full px-3 py-2 text-[13px] transition-colors",
                                        pathname === subItem.href
                                          ? "bg-xai-surface-2 font-medium text-xai-text"
                                          : "text-xai-mute hover:text-xai-text"
                                      )}
                                      onClick={() => router.push(subItem.href)}
                                    >
                                      {subItem.title}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </SidebarMenuItem>
                          </TooltipTrigger>
                          {!open && (
                            <TooltipContent side="right" className="font-medium">
                              {item.title}
                            </TooltipContent>
                          )}
                        </Tooltip>
                      </TooltipProvider>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          {/* 账号区：头像 + 昵称 + 额度，整行即账号菜单触发器。
              侧边栏折叠时只显示头像，菜单依旧可用（此前登出按钮在折叠时会被隐藏）。 */}
          <SidebarFooter className="border-t border-xai-hairline-soft p-0">
            <div className="flex h-[62px] items-center px-5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-full text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-xai-text"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-xai-hairline bg-xai-surface-2 text-[13px] font-medium text-xai-text">
                      {displayName?.[0]?.toUpperCase() || "U"}
                    </span>
                    {open && (
                      <>
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate text-[13px] font-medium text-xai-text-mid"
                            title={displayName}
                          >
                            {displayName}
                          </span>
                          <span className="block truncate text-[11px] text-xai-mute">
                            {quotaText}
                          </span>
                        </span>
                        <IconChevronDown
                          size={14}
                          className="shrink-0 rotate-180 text-xai-eyebrow"
                        />
                      </>
                    )}
                  </button>
                </DropdownMenuTrigger>
                {/* 菜单同样挂在 body 上，补 theme-xai 才能继承控制台的具名令牌 */}
                <DropdownMenuContent
                  side="top"
                  align="start"
                  className="theme-xai w-60 rounded-xl border border-xai-hairline bg-xai-surface p-1.5"
                >
                  <div className="px-2.5 py-2">
                    <p
                      className="truncate text-[13px] font-medium text-xai-text-mid"
                      title={displayName}
                    >
                      {displayName}
                    </p>
                    <p className="truncate text-[11px] text-xai-mute">
                      {quotaText}
                    </p>
                  </div>
                  <DropdownMenuSeparator className="bg-xai-hairline-soft" />
                  <DropdownMenuItem
                    onSelect={() => setPasswordOpen(true)}
                    className="h-9 cursor-pointer gap-2.5 rounded-lg px-2.5 text-[13px] text-xai-text-mid focus:bg-xai-surface-2 focus:text-xai-text"
                  >
                    <KeyRound size={15} className="text-xai-mute" />
                    {tAuth("auth.changePassword")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      void handleLogout();
                    }}
                    className="h-9 cursor-pointer gap-2.5 rounded-lg px-2.5 text-[13px] text-xai-del focus:bg-xai-del-bg focus:text-xai-del"
                  >
                    <IconLogout size={15} />
                    {tAuth("auth.logout")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </SidebarFooter>
        </Sidebar>
        <main className="flex min-w-0 flex-1 flex-col bg-xai-canvas">
          <div className="min-h-0 flex-1">{children}</div>
        </main>
      </SidebarProvider>
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
};

export default DashboardLayout;
