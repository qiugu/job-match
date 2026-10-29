import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Languages, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import { authHeaders, handleUnauthorized } from "@/lib/auth";
import {
  TRANSLATE_LANGUAGES,
  applyTranslatedFields,
  extractTranslatableFields,
} from "@/lib/resumeTranslate";
import { useResumeStore } from "@/store/useResumeStore";
import { generateUUID } from "@/utils/uuid";
import { cn } from "@/lib/utils";

interface TranslateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TranslateMode = "overwrite" | "create";

/** 落地方式选择卡：选中态只换边框与指示点，不改尺寸（避免布局跳动） */
const MODE_CARD_CLASS = cn(
  "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40"
);

const MODE_CARD_ACTIVE_CLASS = "border-ink bg-paper-2";
const MODE_CARD_IDLE_CLASS = "border-line hover:border-line-strong";

/**
 * 简历翻译对话框：选择目标语言与落地方式（覆盖当前 / 新建），调用后端
 * `/api/ai/translate` 对可翻译文本字段做键值映射翻译（见 lib/resumeTranslate）。
 *
 * 落地语义：
 * - 覆盖当前：译文合并进当前简历（走 updateResume，入 history，可用「撤销」恢复），
 *   随后主动落库；
 * - 新建：复制当前简历为新记录并应用译文，标题默认「原标题 · 语言」，即刻落库后
 *   跳转新工作台，原简历保持不变。
 */
export function TranslateDialog({ open, onOpenChange }: TranslateDialogProps) {
  const t = useTranslations("translateResume");
  const router = useRouter();
  const {
    activeResume,
    activeResumeId,
    updateResume,
    addResume,
    syncResumeToBackend,
  } = useResumeStore();

  const [targetLang, setTargetLang] = useState<string>(
    TRANSLATE_LANGUAGES[0]?.code ?? "en"
  );
  const [mode, setMode] = useState<TranslateMode>("overwrite");
  const [newTitle, setNewTitle] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);

  const languageLabel = useMemo(
    () =>
      TRANSLATE_LANGUAGES.find((l) => l.code === targetLang)?.label ?? targetLang,
    [targetLang]
  );

  // 新建模式的标题建议：跟随目标语言变化（「原标题 · English」）。
  // 仅在用户未手动改过（open 时初始化）——用 ref 记录是否手动编辑过。
  const [titleTouched, setTitleTouched] = useState(false);

  useEffect(() => {
    if (!open) {
      // 关闭后重置到默认状态，避免下次打开带着上次的半成品
      setMode("overwrite");
      setTitleTouched(false);
      setIsTranslating(false);
      setTargetLang(TRANSLATE_LANGUAGES[0]?.code ?? "en");
      return;
    }
    setNewTitle(`${activeResume?.title ?? ""} · ${languageLabel}`.trim());
    // 仅在打开瞬间初始化标题（languageLabel 后续变化由 handleLangChange 负责）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleLangChange = (value: string) => {
    setTargetLang(value);
    if (!titleTouched) {
      const label =
        TRANSLATE_LANGUAGES.find((l) => l.code === value)?.label ?? value;
      setNewTitle(`${activeResume?.title ?? ""} · ${label}`.trim());
    }
  };

  const handleTranslate = useCallback(async () => {
    if (!activeResume || !activeResumeId) return;

    const fields = extractTranslatableFields(activeResume);
    if (Object.keys(fields).length === 0) {
      toast.error(t("errorEmpty"));
      return;
    }

    if (!authHeaders().Authorization) {
      handleUnauthorized();
      return;
    }

    setIsTranslating(true);
    try {
      const response = await fetch("/api/ai/translate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ targetLang, fields }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        fields?: Record<string, string>;
        error?: { message?: string } | string;
      };

      if (!response.ok || data.error || !data.fields) {
        const message =
          (typeof data.error === "object" ? data.error?.message : data.error) ||
          t("error");
        throw new Error(message);
      }

      // 服务层只回传输入中出现过的 key；缺 key 回退原文，部分成功仍可用
      const translated = applyTranslatedFields(activeResume, data.fields);

      if (mode === "overwrite") {
        updateResume(activeResumeId, translated);
        await syncResumeToBackend(activeResumeId);
        toast.success(t("successOverwrite", { language: languageLabel }));
        onOpenChange(false);
        return;
      }

      // 新建：复制为新记录 → 应用译文 → 即刻落库 → 跳转新工作台
      const tempId = generateUUID();
      const now = new Date().toISOString();
      const created = {
        ...translated,
        id: tempId,
        title: newTitle.trim() || `${activeResume.title} · ${languageLabel}`,
        createdAt: now,
        updatedAt: now,
      };
      addResume(created);
      const { id: backendId } = await syncResumeToBackend(tempId);
      toast.success(t("successCreate", { language: languageLabel }));
      onOpenChange(false);
      const targetPath = `/app/workbench/${backendId}`;
      router.push({
        to: "/app/workbench/$id",
        params: { id: backendId },
      });
      // 与 handleCopyResume 同款兜底：路由推送偶发不落位时强制跳转
      requestAnimationFrame(() => {
        if (window.location.pathname !== targetPath) {
          window.location.assign(targetPath);
        }
      });
    } catch (error) {
      // 失败保留对话框可重试；简历内容未被触碰（合并发生在响应成功之后）
      toast.error(error instanceof Error ? error.message : t("error"));
    } finally {
      setIsTranslating(false);
    }
  }, [
    activeResume,
    activeResumeId,
    addResume,
    languageLabel,
    mode,
    newTitle,
    onOpenChange,
    router,
    syncResumeToBackend,
    t,
    targetLang,
    updateResume,
  ]);

  return (
    <Dialog open={open} onOpenChange={(next) => !isTranslating && onOpenChange(next)}>
      {/* 工作台为 calm 密度：细线卡片、无硬阴影，与 Drawer/Dock 同一平面语言 */}
      <DialogContent className="max-w-[440px] gap-5 rounded-2xl border-line bg-card p-0 shadow-none">
        <DialogHeader className="space-y-1 px-6 pt-6">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10">
              <Languages className="h-4 w-4 text-cobalt" />
            </span>
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6">
          {/* 目标语言 */}
          <div className="space-y-1.5">
            <Label className="eb-zh">{t("language")}</Label>
            <Select value={targetLang} onValueChange={handleLangChange}>
              <SelectTrigger className="h-10 rounded-lg border-line-strong bg-paper text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSLATE_LANGUAGES.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 落地方式 */}
          <div className="space-y-1.5">
            <Label className="eb-zh">{t("mode")}</Label>
            <div className="space-y-2">
              <button
                type="button"
                aria-pressed={mode === "overwrite"}
                onClick={() => setMode("overwrite")}
                disabled={isTranslating}
                className={cn(
                  MODE_CARD_CLASS,
                  mode === "overwrite"
                    ? MODE_CARD_ACTIVE_CLASS
                    : MODE_CARD_IDLE_CLASS
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                    mode === "overwrite"
                      ? "border-cobalt"
                      : "border-line-strong"
                  )}
                >
                  {mode === "overwrite" && (
                    <span className="h-2 w-2 rounded-full bg-cobalt" />
                  )}
                </span>
                <span>
                  <span className="block text-sm font-medium text-ink">
                    {t("modeOverwrite")}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-3">
                    {t("modeOverwriteDesc")}
                  </span>
                </span>
              </button>

              <button
                type="button"
                aria-pressed={mode === "create"}
                onClick={() => setMode("create")}
                disabled={isTranslating}
                className={cn(
                  MODE_CARD_CLASS,
                  mode === "create"
                    ? MODE_CARD_ACTIVE_CLASS
                    : MODE_CARD_IDLE_CLASS
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                    mode === "create" ? "border-cobalt" : "border-line-strong"
                  )}
                >
                  {mode === "create" && (
                    <span className="h-2 w-2 rounded-full bg-cobalt" />
                  )}
                </span>
                <span>
                  <span className="block text-sm font-medium text-ink">
                    {t("modeCreate")}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-3">
                    {t("modeCreateDesc")}
                  </span>
                </span>
              </button>
            </div>
          </div>

          {/* 新建模式：标题输入 */}
          {mode === "create" && (
            <div className="space-y-1.5">
              <Label className="eb-zh">{t("newTitle")}</Label>
              <Input
                value={newTitle}
                onChange={(e) => {
                  setTitleTouched(true);
                  setNewTitle(e.target.value);
                }}
                disabled={isTranslating}
                placeholder={t("newTitlePlaceholder")}
                className="h-10 rounded-lg border-line-strong bg-paper text-sm"
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isTranslating}
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleTranslate}
            disabled={isTranslating}
            className="gap-1.5"
          >
            {isTranslating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("translating")}
              </>
            ) : (
              <>
                {t("confirm")}
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default TranslateDialog;
