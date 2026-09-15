import { useEffect, useState, type ReactNode } from "react";
import {
  BadgeCheck,
  Check,
  Clock3,
  Copy,
  Loader2,
  Ticket,
} from "lucide-react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "@/i18n/compat/client";
import type { Translator } from "@/i18n/compat/utils";
import {
  ApiError,
  fetchRegistrationCodeStatus,
  issueRegistrationCode,
  type RegistrationCodeIssue,
  type RegistrationCodeStatus,
} from "@/lib/auth";
import { formatCountdown } from "@/utils/countdown";

/** 墙钟时间 HH:mm（跟随浏览器的时区与语言习惯） */
function formatWallTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
  }).format(value);
}

/** 「明天 00:00」/「9月1日 00:00」——下次重置时间以本地时区口语化展示 */
function describeResetTime(iso: string, t: Translator): string {
  const date = new Date(iso);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const time = formatWallTime(date);
  if (date.toDateString() === tomorrow.toDateString()) {
    return t("resetTomorrow", { time });
  }
  return t("resetOn", { date: formatDate(date), time });
}

/** 成功领取后的票券：注册码=入场券。撕票线（虚线）+ 两侧缺口为纯 CSS。 */
function CodeTicket({
  issued,
  hideHint = false,
}: {
  issued: RegistrationCodeIssue;
  /** 登录页等已内嵌领取流程的场景隐藏底部「前往登录页」链接 */
  hideHint?: boolean;
}) {
  const t = useTranslations("home.registrationCode");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（非安全上下文等）时静默失败，码仍可见可手抄
    }
  };

  return (
    <div>
      <div className="relative rounded-xl border-2 border-dashed border-primary/40 bg-primary/[0.04] px-5 py-5">
        <span
          aria-hidden
          className="absolute -left-[13px] top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-background"
        />
        <span
          aria-hidden
          className="absolute -right-[13px] top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-background"
        />

        <div className="flex items-center justify-between gap-3">
          <p className="select-all font-mono text-xl font-bold tracking-[0.14em] sm:text-2xl">
            {issued.code}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 rounded-full"
            onClick={copy}
          >
            {copied ? <Check className="text-primary" /> : <Copy />}
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-dashed border-primary/30 pt-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <BadgeCheck className="text-primary" />
            {t("grantCredits", { count: issued.grantCredits })}
          </span>
          <span>{t("validUntil", { date: formatDate(new Date(issued.expiresAt)) })}</span>
        </div>
      </div>

      {!hideHint && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t("goRegisterHint")}
          <a
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("goRegister")}
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * 注册码自助领取入口：按钮 + 每日限量提示，点击打开「获取注册码」弹框。
 * 弹框顶部展示今日剩余名额与下次重置时间（来自 GET status），
 * 领取成功后以票券样式展示注册码并提供复制。
 *
 * 默认用于首页 FAQ 折叠面板。登录页通过 props 复用：
 * - `trigger` 自定义打开触发器（避免重复「获取注册码」按钮文案）
 * - `onIssued` 领取成功后回调（用于自动回填注册表单的注册码）
 * - `hideGoRegisterHint` 隐藏票券底部「前往登录页」链接
 */
export interface RegistrationCodeCTAProps {
  /** 自定义触发器：传入后由调用方渲染打开按钮，缺省走组件内置「获取注册码」按钮 */
  trigger?: (open: () => void) => ReactNode;
  /** 领取成功回调：登录页用于把注册码自动回填到表单 */
  onIssued?: (issue: RegistrationCodeIssue) => void;
  /** 隐藏票券底部「前往登录页」链接（登录页已内嵌领取流程时） */
  hideGoRegisterHint?: boolean;
  /** 外层容器去掉上间距（登录页已用 space-y 统一控制时） */
  noVerticalMargin?: boolean;
}

export default function RegistrationCodeCTA({
  trigger,
  onIssued,
  hideGoRegisterHint = false,
  noVerticalMargin = false,
}: RegistrationCodeCTAProps) {
  const t = useTranslations("home.registrationCode");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RegistrationCodeStatus | null>(null);
  const [issued, setIssued] = useState<RegistrationCodeIssue | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState("");
  // 触发限流后的冷却截止时刻（429 Retry-After），非空期间禁止再次领取
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldownLeft, setCooldownLeft] = useState(0);

  // 冷却倒计时；归零后自动恢复可领取
  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownLeft(left);
      if (left === 0) setCooldownUntil(null);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  // 打开弹框时拉取名额状态；关闭后清空，下次打开重新查询
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus(null);
    setIssued(null);
    setError("");
    fetchRegistrationCodeStatus()
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || t("loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const exhausted = (status?.remaining ?? 1) <= 0;

  const handleIssue = async () => {
    if (issuing) return;
    setIssuing(true);
    setError("");
    try {
      const data = await issueRegistrationCode();
      setIssued(data);
      // 同步顶部状态条，与领取结果保持一致
      if (status) {
        setStatus({ ...status, remaining: data.remaining, nextResetAt: data.nextResetAt });
      }
      // 登录页等内嵌场景：回填回调后顺滑关闭弹框，由调用方提示已填入
      if (onIssued) {
        onIssued(data);
        setOpen(false);
      }
    } catch (err) {
      const message = (err as Error).message || t("issueFailed");
      setError(message);
      // 弹框内的红字同样容易被忽略，领取失败（尤其是 429 限流）必须弹 toast
      toast.error(message);
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) {
        setCooldownUntil(Date.now() + err.retryAfter * 1000);
      }
    } finally {
      setIssuing(false);
    }
  };

  return (
    <>
      <div
        className={`${noVerticalMargin ? "" : "mt-5"} flex flex-wrap items-center gap-x-4 gap-y-2`}
      >
        {trigger ? (
          // 自定义触发器（登录页等）：由调用方决定打开按钮的文案与样式
          trigger(() => setOpen(true))
        ) : (
          <>
            <Button size="sm" className="rounded-full" onClick={() => setOpen(true)}>
              <Ticket />
              {t("button")}
            </Button>
            <span className="text-sm font-light text-muted-foreground">
              {t("dailyHint")}
            </span>
          </>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-0 overflow-hidden rounded-2xl p-0 sm:rounded-2xl">
          {/* 顶部状态条：下一次重置注册额度的时间 */}
          <div className="flex items-center gap-2.5 border-b bg-primary/5 px-6 py-3.5 text-sm">
            <Clock3 className="shrink-0 text-primary" />
            {status ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {t("remaining", { total: status.dailyLimit, count: status.remaining })}
                </span>
                <span className="mx-2 text-border">|</span>
                {t("resetAt", { time: describeResetTime(status.nextResetAt, t) })}
              </p>
            ) : (
              <p className="text-muted-foreground">{error || t("statusLoading")}</p>
            )}
          </div>

          <div className="px-6 pb-6 pt-5">
            <DialogHeader className="items-start text-left">
              <DialogTitle className="font-serif text-xl tracking-tight">
                {t("dialogTitle")}
              </DialogTitle>
              <DialogDescription>{t("dialogDescription")}</DialogDescription>
            </DialogHeader>

            <div className="mt-5">
              {issued ? (
                <CodeTicket issued={issued} hideHint={hideGoRegisterHint} />
              ) : (
                <div className="space-y-3">
                  <Button
                    className="h-11 w-full rounded-full text-base"
                    onClick={handleIssue}
                    disabled={issuing || exhausted || cooldownLeft > 0}
                  >
                    {issuing ? <Loader2 className="animate-spin" /> : <Ticket />}
                    {cooldownLeft > 0
                      ? t("retryIn", { time: formatCountdown(cooldownLeft) })
                      : t("getCta")}
                  </Button>
                  {exhausted && status ? (
                    // 名额发完是状态而非错误，用中性提示并说明恢复时间
                    <p className="rounded-md bg-muted px-3 py-2 text-center text-sm text-muted-foreground">
                      {t("exhaustedHint")}
                    </p>
                  ) : (
                    error && (
                      <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                        {error}
                      </p>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
