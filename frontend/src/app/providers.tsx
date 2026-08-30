
import { useEffect } from "react";
import { ThemeProvider } from "next-themes";
import { HeroUIProvider } from "@heroui/react";
import { useLocale } from "@/i18n/compat/client";
import { useAuthStore } from "@/store/useAuthStore";
// 2026-08-29 起本地目录文件同步已停用：简历唯一数据源改为后端 master_resumes，
// 不再从 Downloads/简历 等本地目录自动扫描并写入 localStorage。
// import { useResumeDirectorySync } from "@/hooks/useResumeDirectorySync";

export function Providers({ children }: { children: React.ReactNode }) {
  const locale = useLocale();
  const initializeAuth = useAuthStore((state) => state.initialize);
  // useResumeDirectorySync();

  // 启动/刷新时用本地令牌换取用户信息：过期令牌在这里被清掉，
  // 后续路由守卫据此判断是否放行（否则刷新控制台会被误判为未登录）。
  useEffect(() => {
    void initializeAuth();
  }, [initializeAuth]);

  return (
    <HeroUIProvider locale={locale}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
          storageKey="magic-resume-theme"
        >
          {children}
        </ThemeProvider>
    </HeroUIProvider>
  );
}
