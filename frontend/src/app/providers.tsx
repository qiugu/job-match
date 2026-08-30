
import { ThemeProvider } from "next-themes";
import { HeroUIProvider } from "@heroui/react";
import { useLocale } from "@/i18n/compat/client";
// 2026-08-29 起本地目录文件同步已停用：简历唯一数据源改为后端 master_resumes，
// 不再从 Downloads/简历 等本地目录自动扫描并写入 localStorage。
// import { useResumeDirectorySync } from "@/hooks/useResumeDirectorySync";

export function Providers({ children }: { children: React.ReactNode }) {
  const locale = useLocale();
  // useResumeDirectorySync();

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
