/**
 * 游客态登录引导弹窗。
 *
 * 由 /edit 路由挂载的 GuestGateHost 渲染；任何登录墙内功能（PDF 导出、
 * AI 校对、AI 润色、翻译）在游客态被点击时只 request(feature)，
 * 由本弹窗统一呈现「登录后可用」的引导。文案只讲产品事实，
 * 全站禁支付/信用卡话术。
 */

import { useTranslations } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import { useGuestGate, type GuestFeature } from "@/store/useGuestMode";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { LogIn, UserPlus } from "lucide-react";

/** 各功能对应的 i18n key（guest.gate.<feature>） */
const FEATURE_KEYS: Record<GuestFeature, string> = {
  pdf: "pdf",
  grammar: "grammar",
  polish: "polish",
  translate: "translate",
};

export function GuestLoginDialog() {
  const t = useTranslations("guest");
  const router = useRouter();
  const { open, feature, close } = useGuestGate();

  const featureKey = feature ? FEATURE_KEYS[feature] : null;

  /** 登录后回到当前编辑现场（携带 query），由 /login 的开放重定向校验兜底 */
  const currentHref =
    typeof window !== "undefined"
      ? window.location.pathname + window.location.search
      : "/edit";

  const goLogin = () => {
    close();
    router.push({ to: "/login", search: { redirect: currentHref } });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="w-[calc(100%-2rem)] max-w-[420px] gap-0 rounded-2xl border border-border/70 bg-background p-0">
        <div className="px-7 pb-7 pt-7">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-xl font-semibold tracking-tight">
              {featureKey ? t(`gate.${featureKey}.title`) : t("gate.title")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {featureKey
                ? t(`gate.${featureKey}.description`)
                : t("gate.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-6 flex flex-col gap-2.5">
            <button type="button" className="pp-btn w-full" onClick={goLogin}>
              <LogIn className="h-4 w-4" />
              {t("gate.loginButton")}
            </button>
            <button
              type="button"
              className={cn(
                "h-10 w-full rounded-lg border border-line-strong px-3.5",
                "text-[13px] font-medium text-ink-2 transition-colors",
                "hover:border-ink hover:bg-paper-2 hover:text-ink",
                "inline-flex items-center justify-center gap-1.5"
              )}
              onClick={goLogin}
            >
              <UserPlus className="h-4 w-4" />
              {t("gate.registerHint")}
            </button>
            <button
              type="button"
              className="mt-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={close}
            >
              {t("gate.later")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
