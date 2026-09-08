// 修改密码弹窗：从侧边栏底部账号菜单进入。
//
// 后端 POST /api/auth/change-password 校验原密码、递增 token_version 并回发新
// 令牌（旧令牌立即失效，等于把其他设备踢下线）。前端因此必须在成功后落地新
// 令牌，否则后续业务请求会全部 401——这一步在 useAuthStore.changePassword 里。
import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IconX } from "@/components/shared/icons/XaiIcons";
import { useTranslations } from "@/i18n/compat/client";
import { ApiError, handleUnauthorized } from "@/lib/auth";
import { useAuthStore } from "@/store/useAuthStore";

// 与后端 _MIN_PASSWORD / _MAX_PASSWORD 保持一致，先本地拦一遍再发请求
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 密码输入框：右侧眼睛图标切换明文，避免用户在盲输的情况下反复填错。 */
function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete: string;
  autoFocus?: boolean;
}) {
  const t = useTranslations("auth");
  const [visible, setVisible] = useState(false);

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-[13px] text-xai-text-mid">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          className="h-10 pr-10 text-[13px]"
        />
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={visible ? t("hidePassword") : t("showPassword")}
          className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-xai-mute transition-colors hover:text-xai-text"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: ChangePasswordDialogProps) {
  const t = useTranslations("auth");
  const submitting = useAuthStore((state) => state.submitting);
  const changePassword = useAuthStore((state) => state.changePassword);

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 每次打开都是一次干净的填写，避免残留上一次的密码或报错
  useEffect(() => {
    if (open) {
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    // 本地先校验：这些规则后端也会拦，但本地拦能省一次往返并给出更准的提示
    if (!oldPassword) {
      setError(t("oldPasswordRequired"));
      return;
    }
    if (newPassword.length < MIN_PASSWORD) {
      setError(t("passwordTooShort"));
      return;
    }
    if (newPassword.length > MAX_PASSWORD) {
      setError(t("passwordTooLong"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("passwordMismatch"));
      return;
    }
    if (newPassword === oldPassword) {
      setError(t("passwordSameAsOld"));
      return;
    }

    setError(null);
    try {
      await changePassword(oldPassword, newPassword);
      toast.success(t("changePasswordSuccess"));
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // 改密码时会话已过期：跳登录页比在弹窗里报错更有意义
        handleUnauthorized();
        return;
      }
      const message =
        err instanceof Error ? err.message : t("changePasswordFailed");
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 弹窗通过 Portal 挂到 body，落在 .theme-xai 作用域之外；补上 theme-xai
          才能拿到与控制台一致的具名令牌（并在 light 主题下正确反转）。 */}
      <DialogContent
        hideClose
        className="theme-xai max-w-[440px] gap-0 rounded-2xl border border-xai-hairline bg-xai-surface p-0 shadow-none"
      >
        {/* HEADER */}
        <div className="flex items-start justify-between gap-4 border-b border-xai-hairline px-6 py-5">
          <div className="space-y-1.5">
            <p className="xai-eyebrow">SECURITY</p>
            <DialogTitle className="text-[20px] font-medium tracking-tight text-xai-text">
              {t("changePassword")}
            </DialogTitle>
            <DialogDescription className="text-[12.5px] leading-relaxed text-xai-mute">
              {t("changePasswordDesc")}
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t("close")}
            className="-mr-1.5 -mt-1 rounded-full p-2 text-xai-mute transition-colors hover:bg-xai-surface-2 hover:text-xai-text"
          >
            <IconX size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <PasswordField
            id="old-password"
            label={t("oldPassword")}
            value={oldPassword}
            onChange={setOldPassword}
            placeholder={t("oldPasswordPlaceholder")}
            autoComplete="current-password"
            autoFocus
          />
          <PasswordField
            id="new-password"
            label={t("newPassword")}
            value={newPassword}
            onChange={setNewPassword}
            placeholder={t("newPasswordPlaceholder")}
            autoComplete="new-password"
          />
          <div className="space-y-2">
            <PasswordField
              id="confirm-password"
              label={t("confirmPassword")}
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder={t("confirmPasswordPlaceholder")}
              autoComplete="new-password"
            />
            <p className="text-[11.5px] text-xai-mute">{t("passwordRule")}</p>
          </div>

          {error && (
            <p className="rounded-lg bg-xai-del-bg px-3 py-2 text-[12.5px] text-xai-del">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <button
              type="button"
              className="xai-pill-outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("cancel")}
            </button>
            <button type="submit" className="xai-pill-primary" disabled={submitting}>
              {submitting && <Loader2 size={15} className="animate-spin" />}
              {t("submitChangePassword")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
