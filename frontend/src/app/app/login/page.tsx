import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { formatCountdown } from "@/utils/countdown";

import Logo from "@/components/shared/Logo";
import { IcpFilingLink } from "@/components/shared/IcpFiling";
import { PublicSecurityFilingLink } from "@/components/shared/PublicSecurityFiling";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import { useAuthStore } from "@/store/useAuthStore";
import { trackGrowthEvent } from "@/lib/telemetry";
import {
  hasGuestDraft,
  readGuestDraft,
  type GuestDraftRecord,
} from "@/lib/guestDraft";
import { GuestDraftImportDialog } from "@/components/shared/guest/GuestDraftImportDialog";

type Mode = "login" | "register";

interface LoginPageProps {
  /** 登录成功后要回跳的路径（来自 ?redirect=），缺省进控制台 */
  redirectTo?: string;
}

export default function LoginPage({ redirectTo }: LoginPageProps) {
  const t = useTranslations("auth");
  const router = useRouter();
  const submitting = useAuthStore((state) => state.submitting);
  const error = useAuthStore((state) => state.error);
  const login = useAuthStore((state) => state.login);
  const register = useAuthStore((state) => state.register);
  const clearError = useAuthStore((state) => state.clearError);
  // 触发限流后的冷却截止时刻（429 Retry-After），非空期间禁止重复提交
  const cooldownUntil = useAuthStore((state) => state.cooldownUntil);
  const clearCooldown = useAuthStore((state) => state.clearCooldown);

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // 注册态「两次密码不一致」的本地校验错误：前端先拦，不占用 store 的接口 error
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const [cooldownLeft, setCooldownLeft] = useState(0);

  // 游客草稿承接（PLAN_guest_access P3）：登录/注册成功且检测到本地草稿时，
  // 先弹导入确认，用户选择后再跳转。
  const [pendingDraft, setPendingDraft] = useState<GuestDraftRecord | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const defaultTarget = () =>
    mode === "register"
      ? "/app/dashboard/match?onboarding=1"
      : redirectTo || "/app/dashboard";

  // 冷却倒计时：归零时自动解除，用户无需刷新页面
  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownLeft(left);
      if (left === 0) clearCooldown();
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil, clearCooldown]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setConfirmPassword("");
    setPasswordMismatch(false);
    clearError();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || cooldownLeft > 0) return;
    if (mode === "register" && password !== confirmPassword) {
      // 跑到后端只会拿到一条泛指错误，用户还得猜是哪一步；本地先拦
      setPasswordMismatch(true);
      return;
    }
    setPasswordMismatch(false);
    try {
      if (mode === "login") {
        await login(username.trim(), password);
        toast.success(t("loginSuccess"));
      } else {
        void trackGrowthEvent("register_start", { path: "/login" });
        await register(username.trim(), password);
        void trackGrowthEvent("register_success", { path: "/login" });
        toast.success(t("registerSuccess"));
      }
      // 登录成功后先承接游客草稿：有本地草稿则弹导入确认（拒绝则保留草稿），
      // 无草稿按原计划跳转。register 现已开放（注册码可选），同样承接。
      if (hasGuestDraft()) {
        setPendingDraft(readGuestDraft());
        setImportOpen(true);
      } else {
        router.push(defaultTarget());
      }
    } catch (err) {
      // 失败一律弹 toast：表单内的红字容易被忽略，用户会以为「点了没反应」，
      // 限流（429）尤其如此——它往往需要等待，必须给出明确反馈。
      const message =
        err instanceof Error
          ? err.message
          : mode === "login"
            ? t("loginFailed")
            : t("registerFailed");
      toast.error(message);
    }
  };

  const pitchPoints = t.raw("pitchPoints") as string[];

  return (
    <div
      className="relative flex min-h-screen flex-col overflow-hidden bg-paper lg:flex-row"
      data-density="loud"
    >
      {/* ── 左栏：品牌海报（Loud 档唯一的重装饰面）──────────────── */}
      <section
        aria-hidden
        className="relative hidden flex-1 flex-col justify-between overflow-hidden border-r-2 border-ink bg-paper-2 p-12 lg:flex"
      >
        <div className="pp-dotgrid" />
        {/* 撞色块：橘 + 薄荷，面积受控 */}
        <div className="pointer-events-none absolute -right-10 top-16 h-40 w-40 rotate-12 border-2 border-ink bg-tangerine" />
        <div className="pointer-events-none absolute right-24 bottom-40 h-16 w-16 rounded-full border-2 border-ink bg-mint" />

        <div className="relative flex items-center gap-3">
          <Logo size={44} />
          <span className="font-display text-xl font-extrabold tracking-tight text-ink">
            JDMatch
          </span>
        </div>

        <div className="relative max-w-lg">
          <h1 className="font-display text-[42px] font-extrabold leading-[1.08] tracking-tight text-ink">
            {t("pitchTitle")}
          </h1>
          <ul className="mt-8 space-y-3">
            {pitchPoints.map((point) => (
              <li key={point} className="flex items-start gap-3 text-[15px] text-ink-2">
                <span
                  aria-hidden
                  className="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-mint"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#171310" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>

        <span className="pp-sticker relative w-fit -rotate-3">PDF 导出免费</span>
      </section>

      {/* ── 右栏：表单卡 + 备案悬挂位，同轴纵向堆叠居中──────────────
          右栏必须是 flex-col：行向布局会把备案号挤成卡片的兄弟节点甩到最右 */}
      <section className="relative flex flex-1 flex-col items-center justify-center px-4 py-12">
        <Card className="relative w-full max-w-[380px] border-2 border-ink bg-ppcard shadow-punch">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex items-center gap-2 lg:hidden">
              <Logo size={36} />
              <span className="font-display text-lg font-extrabold tracking-tight text-ink">
                JDMatch
              </span>
            </div>
            <CardTitle className="font-display text-2xl font-extrabold text-ink">
              {mode === "login" ? t("title") : t("registerTitle")}
            </CardTitle>
            <CardDescription className="text-ink-2">
              {mode === "login" ? t("subtitle") : t("registerSubtitle")}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="username" className="text-ink-2">{t("username")}</Label>
                <Input
                  id="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={t("usernamePlaceholder")}
                  className="h-11 border-line-strong bg-paper text-ink placeholder:text-ink-3 focus-visible:ring-cobalt"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-ink-2">{t("password")}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordMismatch(false);
                  }}
                  placeholder={t("passwordPlaceholder")}
                  className="h-11 border-line-strong bg-paper text-ink placeholder:text-ink-3 focus-visible:ring-cobalt"
                  required
                />
              </div>

              {/* 注册态才出现：密码确认框，与登录态的极简表单区分开 */}
              {mode === "register" && (
                <div className="space-y-2">
                  <Label htmlFor="confirm-password" className="text-ink-2">
                    {t("registerConfirmPassword")}
                  </Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      setPasswordMismatch(false);
                    }}
                    placeholder={t("registerConfirmPasswordPlaceholder")}
                    className="h-11 border-line-strong bg-paper text-ink placeholder:text-ink-3 focus-visible:ring-cobalt"
                    required
                  />
                </div>
              )}

              {(error || passwordMismatch) && (
                <p className="rounded-lg border border-danger bg-blush px-3 py-2 text-sm font-medium text-danger">
                  {passwordMismatch ? t("registerPasswordMismatch") : error}
                </p>
              )}

              <button
                type="submit"
                className="pp-btn w-full"
                disabled={submitting || cooldownLeft > 0}
              >
                {submitting && <Loader2 className="animate-spin" />}
                {cooldownLeft > 0
                  ? t("retryIn", { time: formatCountdown(cooldownLeft) })
                  : mode === "login"
                    ? t("submitLogin")
                    : t("submitRegister")}
              </button>
            </form>

            {/* 登录 / 注册：文字链接点击切换，不跳路由 */}
            <div className="mt-5 text-center text-sm">
              <button
                type="button"
                className="font-semibold text-cobalt underline-offset-4 transition-colors hover:underline"
                onClick={() => switchMode(mode === "login" ? "register" : "login")}
              >
                {mode === "login" ? t("toRegister") : t("toLogin")}
              </button>
            </div>

            <p className="mt-6 text-center text-xs leading-relaxed text-ink-3">
              {t("notice")}
            </p>
          </CardContent>
        </Card>

        {/* 合规悬挂位：备案号居中展示，并链接至工信部备案管理系统 / 全国互联网安全管理服务平台 */}
        <div className="mt-8 flex flex-col items-center gap-1.5 text-center">
          <IcpFilingLink className="text-[11.5px] text-ink-3 hover:text-ink" />
          <PublicSecurityFilingLink />
        </div>
      </section>

      {/* 游客草稿导入确认（PLAN_guest_access P3）：
          导入 → 建云端简历并清本地副本；跳过 → 保留草稿正常进入控制台 */}
      <GuestDraftImportDialog
        open={importOpen}
        draft={pendingDraft}
        onImported={(backendId) => {
          setImportOpen(false);
          router.push({
            to: "/app/workbench/$id",
            params: { id: backendId }
          });
        }}
        onSkip={() => {
          setImportOpen(false);
          router.push(defaultTarget());
        }}
      />
    </div>
  );
}
