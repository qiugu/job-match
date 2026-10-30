/**
 * 游客态常驻提示条：固定于底部，不打扰编辑器三栏布局（工作台高度
 * 按 100vh 计算，顶部插入横条会挤碎 h-[calc(100vh-64px)] 的布局假设）。
 * 文案只讲事实：内容保存在本浏览器；登录后保存到云端并解锁 AI / PDF 导出。
 */

import { useTranslations } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { CloudUpload, LogIn } from "lucide-react";

export function GuestBanner() {
  const t = useTranslations("guest");
  const router = useRouter();

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 px-4">
      <div
        className={cn(
          "flex items-center gap-3 rounded-full border border-line-strong bg-card",
          "py-2 pl-4 pr-2 shadow-[var(--shadow-chip)]"
        )}
      >
        <CloudUpload className="h-4 w-4 shrink-0 text-ink-3" />
        <span className="whitespace-nowrap text-[12.5px] text-ink-2">
          {t("banner.message")}
        </span>
        <button
          type="button"
          onClick={() =>
            router.push({
              to: "/login",
              search: {
                redirect:
                  typeof window !== "undefined"
                    ? window.location.pathname + window.location.search
                    : "/edit"
              }
            })
          }
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full",
            "border border-cobalt bg-cobalt px-3.5 text-[12.5px] font-semibold text-paper",
            "transition-colors hover:border-cobalt-deep hover:bg-cobalt-deep"
          )}
        >
          <LogIn className="h-3.5 w-3.5" />
          {t("banner.loginButton")}
        </button>
      </div>
    </div>
  );
}
