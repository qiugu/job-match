import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { formatCountdown } from "@/utils/countdown";

import Logo from "@/components/shared/Logo";
import { IcpFilingLink } from "@/components/shared/IcpFiling";
import { PublicSecurityFilingLink } from "@/components/shared/PublicSecurityFiling";
import { Button } from "@/components/ui/button";
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
  const [code, setCode] = useState("");
  const [cooldownLeft, setCooldownLeft] = useState(0);

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
    clearError();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || cooldownLeft > 0) return;
    try {
      if (mode === "login") {
        await login(username.trim(), password);
        toast.success(t("loginSuccess"));
      } else {
        await register(username.trim(), password, code.trim());
        toast.success(t("registerSuccess"));
      }
      router.push(redirectTo || "/app/dashboard");
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

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,hsl(var(--primary)/0.12),transparent_70%)]"
      />
      <Card className="relative w-full max-w-md border-border/60 shadow-xl">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex items-center gap-2">
            <Logo size={40} />
            <span className="text-lg font-bold tracking-tight">JDMatch</span>
          </div>
          <CardTitle className="text-2xl">{t("title")}</CardTitle>
          <CardDescription>{t("subtitle")}</CardDescription>
        </CardHeader>

        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="username">{t("username")}</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={t("usernamePlaceholder")}
                required
              />
            </div>

            {mode === "register" && (
              <div className="space-y-2">
                <Label htmlFor="code">{t("code")}</Label>
                <Input
                  id="code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder={t("codePlaceholder")}
                  autoComplete="off"
                  required
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="password">{t("password")}</Label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("passwordPlaceholder")}
                required
              />
            </div>

            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || cooldownLeft > 0}
            >
              {submitting && <Loader2 className="animate-spin" />}
              {cooldownLeft > 0
                ? t("retryIn", { time: formatCountdown(cooldownLeft) })
                : mode === "login"
                  ? t("submitLogin")
                  : t("submitRegister")}
            </Button>
          </form>

          <div className="mt-4 text-center text-sm">
            <button
              type="button"
              className="text-muted-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
              onClick={() => switchMode(mode === "login" ? "register" : "login")}
            >
              {mode === "login" ? t("toRegister") : t("toLogin")}
            </button>
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
            {t("notice")}
          </p>
        </CardContent>
      </Card>

      {/* 合规悬挂位：备案号居中展示，并链接至工信部备案管理系统 / 全国互联网安全管理服务平台 */}
      <div className="relative mt-12 flex flex-col items-center gap-1.5">
        <IcpFilingLink />
        <PublicSecurityFilingLink />
      </div>
    </div>
  );
}
