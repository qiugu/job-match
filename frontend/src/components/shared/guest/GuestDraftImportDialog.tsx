/**
 * 登录后「导入游客草稿」确认弹窗（PLAN_guest_access P3）。
 *
 * 登录/注册成功且检测到本地游客草稿时弹出：
 * - 导入：以本地草稿内容创建后端简历（复用 syncResumeToBackend 云朵路径），
 *   成功后清除 localStorage 副本并跳到该简历的编辑器；
 * - 暂不导入：保留本地草稿（游客数据绝不静默丢弃），按原计划跳转。
 */

import { useState } from "react";
import { Loader2, Save, CloudOff } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "@/i18n/compat/client";
import { clearGuestDraft, type GuestDraftRecord } from "@/lib/guestDraft";
import { useResumeStore } from "@/store/useResumeStore";

interface GuestDraftImportDialogProps {
  open: boolean;
  draft: GuestDraftRecord | null;
  /** 导入成功后的跳转目标（后端简历 id 由回调生成） */
  onImported: (backendId: string) => void;
  /** 用户选择暂不导入：保留本地草稿，正常跳转 */
  onSkip: () => void;
}

export function GuestDraftImportDialog({
  open,
  draft,
  onImported,
  onSkip,
}: GuestDraftImportDialogProps) {
  const t = useTranslations("guest");
  const [busy, setBusy] = useState(false);

  const handleImport = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const store = useResumeStore.getState();
      const localId = store.addResume(draft.resume);
      // 登录态下 syncResumeToBackend 走云朵路径：POST 创建并替换为后端 id
      const { id: backendId } = await store.syncResumeToBackend(localId);
      clearGuestDraft();
      toast.success(t("import.success"));
      onImported(backendId);
    } catch (err) {
      // 导入失败：保留本地草稿，用户可稍后在游客态或再次登录时导入
      console.error("导入游客草稿失败:", err);
      toast.error(t("import.error"));
      onSkip();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onSkip();
      }}
    >
      <DialogContent className="w-[calc(100%-2rem)] max-w-[420px] gap-0 rounded-2xl border border-border/70 bg-background p-0">
        <div className="px-7 pb-7 pt-7">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-xl font-semibold tracking-tight">
              {t("import.title")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t("import.description", {
                title: draft?.resume.title ?? "",
                time: draft ? new Date(draft.savedAt).toLocaleString() : ""
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-6 flex flex-col gap-2.5">
            <button
              type="button"
              className="pp-btn w-full"
              disabled={busy}
              onClick={handleImport}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {busy ? t("import.busy") : t("import.confirm")}
            </button>
            <button
              type="button"
              disabled={busy}
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-line-strong px-3.5 text-[13px] font-medium text-ink-2 transition-colors hover:border-ink hover:bg-paper-2 hover:text-ink disabled:opacity-50"
              onClick={onSkip}
            >
              <CloudOff className="h-4 w-4" />
              {t("import.skip")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
